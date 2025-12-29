import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as WebSocket from 'ws';
import OpenAI from 'openai';
import { AuthService } from '../auth/auth.service';
import { MessagesService } from '../chat/messages.service';
import { ModerationService } from '../chat/moderation.service';
import { LoggingService } from '../../common/utils/logging.service';
import { BotSession } from '../../common/interfaces';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private session!: BotSession;
  private socket!: WebSocket;
  private readonly SESSION_DURATION = 15 * 60 * 1000; // 15 minutos en milisegundos
  private warningMessages: Set<string> = new Set(); // Para rastrear IDs de mensajes de advertencia
  private moderationPaused = false; // Estado de pausa de moderación
  private pauseEndTime: number | null = null; // Tiempo cuando termina la pausa
  private openai: OpenAI; // Instancia de OpenAI para interpretar comandos

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly messagesService: MessagesService,
    private readonly moderationService: ModerationService,
    private readonly loggingService: LoggingService,
  ) {
    // Inicializar OpenAI para interpretar comandos
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
  }

  async onModuleInit() {
    console.log('🛡️ Inicializando Moderador Bot Service...');
    await this.startBot();
  }

  onModuleDestroy() {
    if (this.socket) {
      this.socket.close();
    }
  }

  private async startBot(): Promise<void> {
    try {
      const cboxUrl = this.configService.get<string>('cbox.url');
      if (!cboxUrl) {
        throw new Error('CBOX_URL no está configurado');
      }

      const { boxId, boxTag, iframeUrl, socketUrl } = await this.authService.getBoxDetails(cboxUrl);
      
      const loginData = await this.authService.login({
        boxId: boxId!,
        boxTag: boxTag!,
        iframeUrl: iframeUrl!,
        password: this.configService.get<string>('cbox.password')!,
        username: this.configService.get<string>('cbox.username')!,
      });

      if (loginData.error) {
        console.error('❌ Error al iniciar sesión:', loginData.error);
        return;
      }

      const { nme, key, pic } = loginData.udata;
      
      // Establecer sesión
      this.session = {
        uname: nme || this.configService.get<string>('cbox.username')!,
        ukey: key!,
        pic: this.configService.get<string>('cbox.defaultPic') || pic || '',
        boxId: boxId!,
        boxTag: boxTag!,
        iframeUrl: iframeUrl!,
        lastLoginTime: Date.now(),
      };

      console.log(`✅ Bot moderador iniciado como ${this.session.uname}`);
      console.log(`🛡️ Moderación automática: ${this.configService.get<boolean>('bot.autoModerateAll') ? 'ENABLED' : 'DISABLED'}`);
      console.log(`🗑️ Eliminación automática: ${this.configService.get<boolean>('bot.autoDeleteMessages') ? 'ENABLED' : 'DISABLED'}`);
      console.log(`⚠️ Advertencias públicas: ${this.configService.get<boolean>('bot.sendModerationWarnings') !== false ? 'ENABLED' : 'DISABLED'}`);
      console.log(`🔒 Protección información personal: ${this.configService.get<boolean>('bot.personalInfoProtection') !== false ? 'ENABLED' : 'DISABLED'}`);

      // Inicializar WebSocket
      this.socket = new WebSocket(socketUrl!);
      this.setupWebSocketHandlers();

    } catch (error) {
      console.error('❌ Error iniciando bot moderador:', error);
      // Reintentar en 30 segundos
      setTimeout(() => this.startBot(), 30000);
    }
  }

  private setupWebSocketHandlers(): void {
    this.socket.on('open', () => {
      console.log('🔌 Conexión WebSocket abierta - Moderador activo');
    });

    this.socket.on('message', async (data: WebSocket.Data) => {
      try {
        await this.handleMessage(data);
      } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
      }
    });

    this.socket.on('error', (error: Error) => {
      console.error('❌ Error de conexión WebSocket:', error.message);
      setTimeout(() => this.startBot(), 5000);
    });

    this.socket.on('close', (code: number, reason: string) => {
      console.log('🔌 Conexión WebSocket cerrada:', code, reason);
      setTimeout(() => this.startBot(), 5000);
    });
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {
    const { date, id, lvl, message, name } = this.messagesService.toDomain(data);
    if(!name || !message || name?.toLowerCase()=== 'aria') {
      return;
    }
    // Debug: mostrar nombre limpio vs nombre del bot
    console.log(`🔍 Comparando nombres: "${name}" vs "${this.session.uname}"`);

    // CRÍTICO: No procesar mensajes del propio bot
    if (name === this.session.uname) {
      console.log(`🚫 Mensaje del bot excluido del procesamiento: "${message?.substring(0, 50)}${message && message.length > 50 ? '...' : ''}"`);
      
      // Detectar si es un mensaje de advertencia y programar su eliminación
      if (message && message.includes('🔇') && message.includes('Mensaje eliminado por')) {
        this.scheduleWarningDeletion(id);
      }
      
      return;
    }

    // Solo guardar el log del mensaje
    if (name && message) {
      await this.loggingService.saveLog(name, message);
    }

    // VERIFICAR COMANDOS DE MODERACIÓN (solo para admins/mods)
    if (name && message) {
      const userLevel = this.getLevelName(parseInt(lvl?.toString() || '1', 10));
      if (userLevel === 'Adm' || userLevel === 'Mod') {
        const commandResult = await this.interpretModerationCommand(message, name, userLevel);
        if (commandResult) {
          return; // No procesar más este mensaje
        }
      }
    }

    // Verificar si la moderación está pausada
    if (this.moderationPaused) {
      if (this.pauseEndTime && Date.now() >= this.pauseEndTime) {
        // La pausa ha expirado, reanudar automáticamente
        this.moderationPaused = false;
        this.pauseEndTime = null;
        console.log('⏰ [MOD-CONTROL] Pausa de moderación expirada - REANUDANDO automáticamente');
        await this.sendModerationStatusMessage('🟢 Moderación REANUDADA automáticamente (tiempo expirado)');
      } else {
        // Mostrar tiempo restante de forma más clara
        const remainingMs = this.pauseEndTime ? this.pauseEndTime - Date.now() : 0;
        const remainingTime = this.formatRemainingTime(remainingMs);
        console.log(`⏸️ [MOD-CONTROL] Moderación pausada - mensaje de ${name} no procesado (${remainingTime} restantes)`);
        return; // No moderar mientras está pausado
      }
    }

    // MODERACIÓN AUTOMÁTICA - Procesar TODOS los mensajes
    const autoModerateAll = this.configService.get<boolean>('bot.autoModerateAll');
    if (autoModerateAll && name && message) {
      console.log(`🛡️ [AUTO-MOD] Moderando mensaje de ${name}...`);
      
      try {
        const moderationResult = await this.moderationService.moderateMessage(
          message, 
          name, 
          parseInt(lvl?.toString() || '1', 10)
        );

        if (!moderationResult.isAllowed) {
          console.log(`🚫 [MOD] Mensaje bloqueado de ${name}: ${moderationResult.reason}`);
          
          // Crear función de eliminación para pasar al servicio de moderación
          const deleteMessageFunction = async (messageId: string): Promise<boolean> => {
            return await this.messagesService.deleteMessage({
              key: this.session.ukey,
              messageId: messageId,
              username: this.session.uname,
              boxId: this.session.boxId,
              boxTag: this.session.boxTag,
              iframeUrl: this.session.iframeUrl,
            });
          };
          
          // Ejecutar acción de moderación (enviar advertencia y/o eliminar mensaje si es necesario)
          const warningMessage = await this.moderationService.executeModeration(
            moderationResult, 
            name, 
            id,
            deleteMessageFunction
          );
          
          // Enviar advertencia solo si está configurado
          const sendWarnings = this.configService.get<boolean>('bot.sendModerationWarnings') ?? true;
          if (warningMessage && sendWarnings) {
            const textColor = this.configService.get<string>('bot.textColor');
            const colorPrefix = textColor ? `^#${textColor} ` : '';
            
            await this.sendMessageWithSessionCheck({
              message: `${colorPrefix}${warningMessage}`,
              username: this.session.uname,
              key: this.session.ukey,
              pic: this.session.pic,
              boxTag: this.session.boxTag,
              boxId: this.session.boxId,
              iframeUrl: this.session.iframeUrl,
            });
          }
          
          // IMPORTANTE: Terminar procesamiento aquí para mensajes bloqueados
          return;
        }
        
        console.log(`✅ [MOD] Mensaje aprobado de ${name}`);
      } catch (error) {
        console.error('❌ [MOD] Error en moderación automática:', error);
      }
    }
  }

  // Método para renovar la sesión cuando sea necesario
  private async renewSessionIfNeeded(): Promise<boolean> {
    const currentTime = Date.now();
    const timeSinceLastLogin = currentTime - this.session.lastLoginTime;

    // Si ha pasado más de 15 minutos desde el último login, renovar la sesión
    if (timeSinceLastLogin > this.SESSION_DURATION) {
      console.log(`🔄 Renovando sesión... (${Math.round(timeSinceLastLogin / (60 * 1000))} minutos desde último login)`);
      
      try {
        const loginData = await this.authService.login({
          boxId: this.session.boxId,
          boxTag: this.session.boxTag,
          iframeUrl: this.session.iframeUrl,
          password: this.configService.get<string>('cbox.password')!,
          username: this.configService.get<string>('cbox.username')!,
        });
        
        if (loginData.error) {
          console.error('❌ Error renovando sesión:', loginData.error);
          return false;
        }
        
        // Actualizar session con nueva información
        const { nme, key, pic } = loginData.udata;
        this.session.ukey = key!;
        this.session.pic = pic || this.session.pic;
        this.session.lastLoginTime = currentTime;
        
        console.log(`✅ Sesión renovada exitosamente para ${nme}`);
        return true;
        
      } catch (error) {
        console.error('❌ Error en renovación de sesión:', error);
        return false;
      }
    }
    
    return true; // No necesita renovación
  }

  /**
   * Programa la eliminación de un mensaje de advertencia después de 10 segundos
   */
  private scheduleWarningDeletion(messageId: string): void {
    console.log(`⏰ Programando eliminación de advertencia ${messageId} en 10 segundos...`);
    
    setTimeout(async () => {
      try {
        await this.deleteMessage(messageId);
        console.log(`✅ Mensaje de advertencia ${messageId} eliminado automáticamente`);
      } catch (error) {
        console.error(`❌ Error eliminando mensaje de advertencia ${messageId}:`, error);
      }
    }, 10000); // 10 segundos
  }

  /**
   * Elimina un mensaje específico del chat
   */
  private async deleteMessage(messageId: string): Promise<void> {
    try {
      const sessionValid = await this.renewSessionIfNeeded();
      if (!sessionValid) {
        console.error('❌ No se pudo renovar la sesión para eliminar mensaje');
        return;
      }

      const baseUrl = this.session.iframeUrl?.split('?')[0];
      const deleteUrl = `${baseUrl}?sec=delban&boxid=${this.session.boxId}&boxtag=${this.session.boxTag}&_v=1063&n=${this.session.uname}&k=${this.session.ukey}&del=${messageId}`;
      
      console.log(`🗑️ [AUTO-DELETE] Eliminando advertencia ID: ${messageId}`);
      
      const response = await fetch(deleteUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const result = await response.text();
      console.log(`🗑️ [AUTO-DELETE] Respuesta: ${result}`);
      
      if (result.includes('OK') || result.includes('success')) {
        console.log(`✅ [AUTO-DELETE] Advertencia ${messageId} eliminada exitosamente`);
      } else {
        console.log(`⚠️ [AUTO-DELETE] Respuesta inesperada para ${messageId}: ${result}`);
      }
    } catch (error) {
      console.error(`❌ Error eliminando advertencia ${messageId}:`, error);
    }
  }

  /**
   * Interpreta comandos de moderación usando GPT de forma dinámica
   */
  private async interpretModerationCommand(message: string, username: string, userLevel: string): Promise<boolean> {
    try {
      const systemPrompt = `Eres un intérprete de comandos para un bot de moderación. Analiza si el mensaje contiene una intención de controlar la moderación del chat.

RESPONDE SOLO CON UNO DE ESTOS FORMATOS JSON:

Para pausar moderación:
{"action": "pause", "duration": NÚMERO, "unit": "minutes|hours|days|weeks", "reason": "motivo opcional"}

Para reanudar moderación:
{"action": "resume", "reason": "motivo opcional"}

Para consultar estado:
{"action": "status"}

Para NO hacer nada (mensaje normal):
{"action": "none"}

EJEMPLOS DE MENSAJES QUE SÍ SON COMANDOS:
- "pausa el bot 30 minutos" → {"action": "pause", "duration": 30, "unit": "minutes"}
- "desactiva la moderación por 2 horas" → {"action": "pause", "duration": 2, "unit": "hours"}
- "pausa moderación 1 día" → {"action": "pause", "duration": 1, "unit": "days"}
- "detén bot 3 días" → {"action": "pause", "duration": 3, "unit": "days"}
- "para moderación 1 semana" → {"action": "pause", "duration": 1, "unit": "weeks"}
- "reactiva el bot" → {"action": "resume"}
- "reanuda moderación" → {"action": "resume"}
- "como está el bot?" → {"action": "status"}
- "estado de moderación" → {"action": "status"}

UNIDADES VÁLIDAS: minutes, hours, days, weeks
IMPORTANTE: Identifica correctamente la unidad de tiempo mencionada en el mensaje.

EJEMPLOS DE MENSAJES QUE NO SON COMANDOS:
- "hola como están" → {"action": "none"}
- "que opinan del anime" → {"action": "none"}
- "alguien vio el episodio" → {"action": "none"}

Analiza: "${message}"`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }],
        max_tokens: 150,
        temperature: 0.1,
      });

      const result = response.choices[0]?.message?.content?.trim();
      if (!result) return false;

      console.log(`🤖 [GPT-COMMAND] Interpretación para "${message}": ${result}`);

      const command = JSON.parse(result);
      
      if (command.action === 'none') {
        return false; // No es un comando
      }

      return await this.executeInterpretedCommand(command, username, userLevel, message);

    } catch (error) {
      console.error('❌ Error interpretando comando con GPT:', error);
      return false;
    }
  }

  /**
   * Ejecuta el comando interpretado por GPT
   */
  private async executeInterpretedCommand(command: any, username: string, userLevel: string, originalMessage: string): Promise<boolean> {
    console.log(`🎛️ [MOD-CONTROL] Comando GPT de ${username} (${userLevel}): ${JSON.stringify(command)}`);

    switch (command.action) {
      case 'pause':
        const duration = command.duration || 30;
        const unit = command.unit || 'minutes';
        
        let milliseconds: number;
        let timeText: string;
        
        switch (unit) {
          case 'weeks':
            milliseconds = duration * 7 * 24 * 60 * 60 * 1000;
            timeText = `${duration} semana(s)`;
            break;
          case 'days':
            milliseconds = duration * 24 * 60 * 60 * 1000;
            timeText = `${duration} día(s)`;
            break;
          case 'hours':
            milliseconds = duration * 60 * 60 * 1000;
            timeText = `${duration} hora(s)`;
            break;
          case 'minutes':
          default:
            milliseconds = duration * 60 * 1000;
            timeText = `${duration} minuto(s)`;
            break;
        }
        
        this.moderationPaused = true;
        this.pauseEndTime = Date.now() + milliseconds;
        
        const reason = command.reason ? ` (${command.reason})` : '';
        
        console.log(`⏸️ [MOD-CONTROL] Moderación PAUSADA por ${username} durante ${timeText}${reason}`);
        
        await this.sendModerationStatusMessage(
          `🔴 Moderación PAUSADA por ${username} durante ${timeText}${reason}`
        );
        return true;

      case 'resume':
        this.moderationPaused = false;
        this.pauseEndTime = null;
        
        const resumeReason = command.reason ? ` (${command.reason})` : '';
        
        console.log(`▶️ [MOD-CONTROL] Moderación REANUDADA por ${username}${resumeReason}`);
        
        await this.sendModerationStatusMessage(
          `🟢 Moderación REANUDADA por ${username}${resumeReason}`
        );
        return true;

      case 'status':
        const status = this.moderationPaused ? 'PAUSADA' : 'ACTIVA';
        let statusMessage = `📊 Estado de moderación: ${status}`;
        
        if (this.moderationPaused && this.pauseEndTime) {
          const remainingMs = this.pauseEndTime - Date.now();
          const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
          const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
          const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
          
          let timeRemaining: string;
          if (remainingMs >= 24 * 60 * 60 * 1000) { // Más de 1 día
            timeRemaining = `${remainingDays} día(s)`;
          } else if (remainingMs >= 60 * 60 * 1000) { // Más de 1 hora
            timeRemaining = `${remainingHours} hora(s)`;
          } else { // Menos de 1 hora
            timeRemaining = `${remainingMinutes} min`;
          }
          
          statusMessage += ` (${timeRemaining} restantes)`;
        }
        
        console.log(`📊 [MOD-CONTROL] Estado consultado por ${username}: ${status}`);
        await this.sendModerationStatusMessage(statusMessage);
        return true;

      default:
        return false;
    }
  }

  /**
   * Verifica si un mensaje es un comando de moderación
   */
  private isModeratorCommand(message: string): boolean {
    const lowerMessage = message.toLowerCase().trim();
    const commands = [
      /^!pausar?\s+(moderacion|mod)\s*(\d+)?\s*(min|minutos|h|horas?)?/i,
      /^!reanudar?\s+(moderacion|mod)/i,
      /^!estado\s+(moderacion|mod)/i,
    ];
    
    return commands.some(pattern => pattern.test(lowerMessage));
  }

  /**
   * Convierte el nivel numérico a nombre
   */
  private getLevelName(level: number): string {
    switch (level) {
      case 5: return 'Adm';
      case 4: return 'Adm';
      case 3: return 'Mod';
      case 2: return 'Reg+';
      case 1: return 'Reg';
      default: return 'Guest';
    }
  }

  /**
   * Maneja comandos de moderación de admins/mods
   */
  private async handleModerationCommand(message: string, username: string, userLevel: string): Promise<void> {
    const lowerMessage = message.toLowerCase().trim();
    
    console.log(`🎛️ [MOD-CONTROL] Comando recibido de ${username} (${userLevel}): ${message}`);

    // Comando: Pausar moderación
    const pauseMatch = lowerMessage.match(/^!pausar?\s+(moderacion|mod)\s*(\d+)?\s*(min|minutos|h|horas?)?/i);
    if (pauseMatch) {
      const duration = parseInt(pauseMatch[2] || '30', 10);
      const unit = pauseMatch[3]?.toLowerCase() || 'min';
      
      let milliseconds: number;
      if (unit.startsWith('h')) {
        milliseconds = duration * 60 * 60 * 1000; // horas a ms
      } else {
        milliseconds = duration * 60 * 1000; // minutos a ms
      }
      
      this.moderationPaused = true;
      this.pauseEndTime = Date.now() + milliseconds;
      
      const timeText = unit.startsWith('h') ? `${duration} hora(s)` : `${duration} minuto(s)`;
      console.log(`⏸️ [MOD-CONTROL] Moderación PAUSADA por ${username} durante ${timeText}`);
      
      await this.sendModerationStatusMessage(
        `🔴 Moderación PAUSADA por ${username} durante ${timeText}`
      );
      return;
    }

    // Comando: Reanudar moderación
    if (/^!reanudar?\s+(moderacion|mod)/i.test(lowerMessage)) {
      this.moderationPaused = false;
      this.pauseEndTime = null;
      
      console.log(`▶️ [MOD-CONTROL] Moderación REANUDADA por ${username}`);
      
      await this.sendModerationStatusMessage(
        `🟢 Moderación REANUDADA por ${username}`
      );
      return;
    }

    // Comando: Estado de moderación
    if (/^!estado\s+(moderacion|mod)/i.test(lowerMessage)) {
      const status = this.moderationPaused ? 'PAUSADA' : 'ACTIVA';
      let statusMessage = `📊 Estado de moderación: ${status}`;
      
      if (this.moderationPaused && this.pauseEndTime) {
        const remainingMs = this.pauseEndTime - Date.now();
        const remainingMin = Math.ceil(remainingMs / (60 * 1000));
        statusMessage += ` (${remainingMin} min restantes)`;
      }
      
      console.log(`📊 [MOD-CONTROL] Estado consultado por ${username}: ${status}`);
      await this.sendModerationStatusMessage(statusMessage);
      return;
    }
  }

  /**
   * Envía un mensaje de estado de moderación
   */
  private async sendModerationStatusMessage(message: string): Promise<void> {
    const textColor = this.configService.get<string>('bot.textColor');
    const colorPrefix = textColor ? `^#${textColor} ` : '';
    
    await this.sendMessageWithSessionCheck({
      message: `${colorPrefix}${message}`,
      username: this.session.uname,
      key: this.session.ukey,
      pic: this.session.pic,
      boxTag: this.session.boxTag,
      boxId: this.session.boxId,
      iframeUrl: this.session.iframeUrl,
    });
  }

  private async sendMessageWithSessionCheck(messageData: any): Promise<void> {
    try {
      // Verificar si la sesión necesita renovación antes de enviar mensaje
      const sessionValid = await this.renewSessionIfNeeded();
      if (!sessionValid) {
        console.error('❌ No se pudo renovar la sesión, no se enviará el mensaje');
        return;
      }

      console.log(`📤 [Enviando advertencia]: ${messageData.message}`);
      
      const response = await this.messagesService.sendMessage(messageData);
      console.log(`✅ Advertencia de moderación enviada exitosamente`);
    } catch (error) {
      console.error(`❌ Error enviando advertencia de moderación:`, error);
      
      // En caso de error, intentar renovar sesión para el próximo mensaje
      await this.renewSessionIfNeeded();
    }
  }

  /**
   * Formatea el tiempo restante en unidades legibles
   */
  private formatRemainingTime(milliseconds: number): string {
    const minutes = Math.ceil(milliseconds / (60 * 1000));
    const hours = Math.ceil(milliseconds / (60 * 60 * 1000));
    const days = Math.ceil(milliseconds / (24 * 60 * 60 * 1000));
    
    if (milliseconds >= 24 * 60 * 60 * 1000) { // Más de 1 día
      return `${days} día(s)`;
    } else if (milliseconds >= 60 * 60 * 1000) { // Más de 1 hora
      return `${hours} hora(s)`;
    } else { // Menos de 1 hora
      return `${minutes} min`;
    }
  }

  // Cron job para renovar sesión automáticamente cada 10 minutos
  @Cron(CronExpression.EVERY_10_MINUTES)
  private async autoRenewSession(): Promise<void> {
    console.log('🔄 Ejecutando renovación automática de sesión...');
    await this.renewSessionIfNeeded();
  }
}