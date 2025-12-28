import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

interface ModerationResult {
  isAllowed: boolean;
  reason?: string;
  severity: 'low' | 'medium' | 'high';
  category?: string;
  action: 'allow' | 'warn' | 'timeout' | 'ban';
}

@Injectable()
export class ModerationService {
  private openai: OpenAI;
  private moderationEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
    
    this.moderationEnabled = this.configService.get<boolean>('bot.moderationEnabled') ?? true;
  }

  /**
   * Modera un mensaje usando GPT-4
   */
  async moderateMessage(
    message: string, 
    username: string, 
    userLevel: number = 1
  ): Promise<ModerationResult> {
    
    // Si la moderación está deshabilitada, permitir todo
    if (!this.moderationEnabled) {
      return {
        isAllowed: true,
        severity: 'low',
        action: 'allow'
      };
    }

    try {
      console.log(`🛡️ [MOD] Moderando mensaje de ${username} (nivel ${userLevel}): "${message}"`);

      const systemPrompt = this.buildModerationPrompt(userLevel);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Modelo más económico pero efectivo para moderación
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Usuario: ${username} (Nivel: ${userLevel})\nMensaje: "${message}"` }
        ],
        max_tokens: 200,
        temperature: 0.1, // Baja temperatura para respuestas consistentes
      });

      const result = response.choices[0]?.message?.content?.trim();
      
      if (!result) {
        console.warn('⚠️ [MOD] Respuesta vacía del moderador, permitiendo mensaje');
        return {
          isAllowed: true,
          severity: 'low',
          action: 'allow'
        };
      }

      return this.parseModerationResult(result, message, username);
      
    } catch (error) {
      console.error('❌ [MOD] Error en moderación automática:', error);
      
      // En caso de error, usar moderación básica local
      return this.fallbackModeration(message, username, userLevel);
    }
  }

  /**
   * Construye el prompt de moderación según el nivel del usuario
   */
  private buildModerationPrompt(userLevel: number): string {
    const baseRules = `
Eres un moderador automático de un chat de anime/manga. Analiza el mensaje y determina si debe ser permitido.

SOLO MODERA POR:
1. ❌ Insultos directos, groserías o lenguaje ofensivo hacia usuarios
2. ❌ Spam evidente (mensajes idénticos repetidos múltiples veces)
3. ❌ Contenido sexual explícito
4. ❌ Amenazas directas o incitación a la violencia
5. ❌ Discriminación grave o hate speech
6. ❌ Contenido claramente ilegal

NO MODERES POR:
1. ✅ Mensajes cortos o de pocas palabras
2. ✅ Conversaciones que se salen del tema (anime/manga)
3. ✅ Mensajes normales de conversación
4. ✅ Bromas ligeras o comentarios casuales
5. ✅ Opiniones fuertes pero respetuosas
6. ✅ Enlaces normales o recomendaciones
7. ✅ Expresiones emocionales normales
8. ✅ Apodos o nombres de usuario inofensivos (enana, gordo, etc.)

NIVELES DE USUARIO:
- Nivel 1: No registrado (moderación estricta)
- Nivel 2: Registrado (moderación normal)  
- Nivel 3: Moderador (moderación relajada)
- Nivel 4: Admin (casi sin restricciones)`;

    const levelSpecificRules = this.getLevelSpecificRules(userLevel);

    return `${baseRules}

${levelSpecificRules}

RESPONDE EN FORMATO JSON:
{
  "allowed": true/false,
  "severity": "low"/"medium"/"high",
  "reason": "explicación breve",
  "category": "spam"/"nsfw"/"toxicity"/"offtopic"/"promotion"/"illegal",
  "action": "allow"/"warn"/"timeout"/"ban"
}

ACCIONES:
- allow: Permitir el mensaje
- warn: Solo advertencia (para casos menores)
- timeout: Eliminar mensaje + advertencia (para insultos directos y spam)
- ban: Eliminar mensaje + advertencia severa (para amenazas y discriminación)

EJEMPLOS:
- "Me gusta Naruto" → {"allowed": true, "severity": "low", "action": "allow"}
- "hola" → {"allowed": true, "severity": "low", "action": "allow"}
- "que aburrido esto" → {"allowed": true, "severity": "low", "action": "allow"}
- "alguien ha visto la nueva película?" → {"allowed": true, "severity": "low", "action": "allow"}
- "eres un idiota" → {"allowed": false, "severity": "medium", "reason": "Insulto directo", "category": "toxicity", "action": "timeout"}
- "SPAM SPAM SPAM SPAM" → {"allowed": false, "severity": "high", "reason": "Spam evidente", "category": "spam", "action": "timeout"}
- "voy a matarte" → {"allowed": false, "severity": "high", "reason": "Amenaza directa", "category": "toxicity", "action": "ban"}`;
  }

  /**
   * Reglas específicas según el nivel del usuario
   */
  private getLevelSpecificRules(userLevel: number): string {
    switch (userLevel) {
      case 1: // No registrado
        return `USUARIO NO REGISTRADO - MODERACIÓN ENFOCADA:
- Vigilar spam más estrictamente
- Cuidado con insultos o groserías
- Permitir conversaciones normales aunque sean off-topic`;
        
      case 2: // Registrado
        return `USUARIO REGISTRADO - MODERACIÓN BÁSICA:
- Solo moderar insultos claros y spam
- Permitir todo tipo de conversaciones casuales
- Libertad para expresarse normalmente`;
        
      case 3: // Moderador
        return `MODERADOR - MODERACIÓN MÍNIMA:
- Solo intervenir en casos graves de insultos o amenazas
- Permitir lenguaje directo y expresiones fuertes
- Libertad casi total de expresión`;
        
      case 4: // Admin
        return `ADMINISTRADOR - SIN MODERACIÓN:
- Solo bloquear contenido claramente ilegal
- Libertad completa de expresión
- Confiar en su criterio como admin`;
        
      default:
        return `USUARIO DESCONOCIDO - MODERACIÓN ESTRICTA`;
    }
  }

  /**
   * Parsea la respuesta del modelo de moderación
   */
  private parseModerationResult(
    result: string, 
    message: string, 
    username: string
  ): ModerationResult {
    try {
      // Intentar parsear JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No se encontró JSON en la respuesta');
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      const moderationResult: ModerationResult = {
        isAllowed: parsed.allowed === true,
        severity: parsed.severity || 'medium',
        reason: parsed.reason,
        category: parsed.category,
        action: parsed.action || (parsed.allowed ? 'allow' : 'warn')
      };

      console.log(`🛡️ [MOD] Resultado para ${username}:`, moderationResult);
      
      return moderationResult;
      
    } catch (error) {
      console.error('❌ [MOD] Error parseando respuesta de moderación:', error);
      console.error('❌ [MOD] Respuesta recibida:', result);
      
      // Fallback en caso de error de parsing
      return this.fallbackModeration(message, username, 1);
    }
  }

  /**
   * Moderación básica local como fallback
   */
  private fallbackModeration(
    message: string, 
    username: string, 
    userLevel: number
  ): ModerationResult {
    const lowerMessage = message.toLowerCase();
    
    // Palabras prohibidas básicas
    const bannedWords = ['puto', 'puta', 'idiota', 'estúpido', 'maricón', 'gay', 'negro'];
    const spamIndicators = ['compra', 'vende', 'gratis', '!!!', 'www.', 'http'];
    
    // Verificar palabras prohibidas
    const hasBannedWord = bannedWords.some(word => lowerMessage.includes(word));
    if (hasBannedWord) {
      return {
        isAllowed: false,
        severity: 'medium',
        reason: 'Lenguaje inapropiado detectado',
        category: 'toxicity',
        action: userLevel >= 3 ? 'warn' : 'timeout'
      };
    }
    
    // Verificar spam
    const spamScore = spamIndicators.filter(indicator => lowerMessage.includes(indicator)).length;
    if (spamScore >= 2) {
      return {
        isAllowed: false,
        severity: 'medium',
        reason: 'Posible spam detectado',
        category: 'spam',
        action: 'warn'
      };
    }
    
    // Si no hay problemas detectados
    return {
      isAllowed: true,
      severity: 'low',
      action: 'allow'
    };
  }

  /**
   * Ejecuta la acción de moderación recomendada
   */
  async executeModeration(
    result: ModerationResult,
    username: string,
    messageId?: string,
    deleteMessage?: (messageId: string) => Promise<boolean>
  ): Promise<string | null> {
    
    if (result.isAllowed) {
      return null; // No hay acción necesaria
    }

    console.log(`⚖️ [MOD] Ejecutando acción ${result.action} para ${username}: ${result.reason}`);

    // Verificar si la eliminación automática está habilitada
    const autoDeleteEnabled = this.configService.get<boolean>('bot.autoDeleteMessages') ?? false;

    switch (result.action) {
      case 'warn':
        // Si es un warning por toxicidad (insultos), eliminar el mensaje también
        if (result.category === 'toxicity' && autoDeleteEnabled && messageId && deleteMessage) {
          console.log(`🗑️ [MOD] Intentando eliminar mensaje ${messageId} (warn toxicity) - Auto-delete: ENABLED`);
          try {
            const deleted = await deleteMessage(messageId);
            if (deleted) {
              return `⚠️ ${username}: Mensaje eliminado - ${result.reason}. Por favor, mantén el respeto en el chat.`;
            } else {
              return `⚠️ ${username}: ${result.reason}. Por favor, mantén el respeto en el chat. (eliminación falló)`;
            }
          } catch (error) {
            console.error(`❌ [MOD] Error eliminando mensaje ${messageId}:`, error);
            return `⚠️ ${username}: ${result.reason}. Por favor, mantén el respeto en el chat. (error en eliminación)`;
          }
        } else {
          return `⚠️ ${username}: ${result.reason}. Por favor, mantén el respeto en el chat.`;
        }
        
      case 'timeout':
        // Intentar eliminar el mensaje solo si está habilitado y se proporcionó el ID y la función
        if (autoDeleteEnabled && messageId && deleteMessage) {
          console.log(`🗑️ [MOD] Intentando eliminar mensaje ${messageId} (timeout) - Auto-delete: ENABLED`);
          try {
            const deleted = await deleteMessage(messageId);
            if (deleted) {
              return `🔇 ${username}: Mensaje eliminado por ${result.reason}`;
            } else {
              return `🔇 ${username}: Mensaje bloqueado - ${result.reason} (eliminación falló)`;
            }
          } catch (error) {
            console.error(`❌ [MOD] Error eliminando mensaje ${messageId}:`, error);
            return `🔇 ${username}: Mensaje bloqueado - ${result.reason} (error en eliminación)`;
          }
        } else {
          console.log(`⚠️ [MOD] Eliminación automática: ${autoDeleteEnabled ? 'ENABLED' : 'DISABLED'}`);
          return `🔇 ${username}: Mensaje bloqueado - ${result.reason}`;
        }
        
      case 'ban':
        // Intentar eliminar el mensaje solo si está habilitado y se proporcionó el ID y la función
        if (autoDeleteEnabled && messageId && deleteMessage) {
          console.log(`🗑️ [MOD] Intentando eliminar mensaje ${messageId} (ban) - Auto-delete: ENABLED`);
          try {
            const deleted = await deleteMessage(messageId);
            if (deleted) {
              return `🔨 ${username}: Mensaje eliminado por comportamiento inaceptable - ${result.reason}`;
            } else {
              return `🔨 ${username}: Comportamiento inaceptable - ${result.reason} (eliminación falló)`;
            }
          } catch (error) {
            console.error(`❌ [MOD] Error eliminando mensaje ${messageId}:`, error);
            return `🔨 ${username}: Comportamiento inaceptable - ${result.reason} (error en eliminación)`;
          }
        } else {
          console.log(`⚠️ [MOD] Eliminación automática: ${autoDeleteEnabled ? 'ENABLED' : 'DISABLED'}`);
          return `🔨 ${username}: Comportamiento inaceptable - ${result.reason}`;
        }
        
      default:
        return null;
    }
  }

  /**
   * Obtiene estadísticas de moderación
   */
  getModerationStats(): any {
    // Aquí podrías implementar un sistema de estadísticas
    return {
      enabled: this.moderationEnabled,
      model: 'gpt-4o-mini',
      status: 'active'
    };
  }

  /**
   * Habilita/deshabilita la moderación
   */
  setModerationEnabled(enabled: boolean): void {
    this.moderationEnabled = enabled;
    console.log(`🛡️ [MOD] Moderación automática ${enabled ? 'habilitada' : 'deshabilitada'}`);
  }
}