# 🎛️ Comandos de Control de Moderación

Este documento describe los comandos disponibles para que moderadores y administradores controlen el bot de moderación.

## 🔑 Permisos Requeridos

Solo usuarios con nivel **Moderador** (`Mod`) o **Administrador** (`Adm`) pueden usar estos comandos.

## 📝 Comandos Disponibles

### ⏸️ Pausar Moderación

```
!pausar moderacion [tiempo] [unidad]
!pausar mod [tiempo] [unidad]
```

**Ejemplos:**
- `!pausar moderacion` - Pausa por 30 minutos (por defecto)
- `!pausar mod 15` - Pausa por 15 minutos
- `!pausar moderacion 2 horas` - Pausa por 2 horas
- `!pausar mod 60 min` - Pausa por 60 minutos

**Unidades válidas:** `min`, `minutos`, `h`, `horas`

### ▶️ Reanudar Moderación

```
!reanudar moderacion
!reanudar mod
```

**Ejemplos:**
- `!reanudar moderacion` - Reanuda la moderación inmediatamente
- `!reanudar mod` - Reanuda la moderación inmediatamente

### 📊 Consultar Estado

```
!estado moderacion
!estado mod
```

**Ejemplos:**
- `!estado moderacion` - Muestra si está activa/pausada y tiempo restante
- `!estado mod` - Muestra el estado actual

## 🔄 Comportamiento Automático

- **Expiración automática**: Si se pausa por tiempo, se reanuda automáticamente al terminar
- **Persistencia**: El estado se mantiene durante reinicios del bot
- **Logs detallados**: Todas las acciones se registran en la consola

## 📋 Ejemplos de Uso

### Escenario 1: Evento Especial
```
Moderador: !pausar moderacion 2 horas
Bot: 🔴 Moderación PAUSADA por Moderador durante 2 hora(s)

[... evento especial sin moderación ...]

Bot: 🟢 Moderación REANUDADA automáticamente (tiempo expirado)
```

### Escenario 2: Emergencia
```
Administrador: !pausar mod 5
Bot: 🔴 Moderación PAUSADA por Administrador durante 5 minuto(s)

[... resolver problema ...]

Administrador: !reanudar mod
Bot: 🟢 Moderación REANUDADA por Administrador
```

### Escenario 3: Consulta
```
Moderador: !estado moderacion
Bot: 📊 Estado de moderación: PAUSADA (12 min restantes)
```

## 🛡️ Niveles de Usuario Reconocidos

| Nivel Numérico | Nombre | Permisos |
|---------------|--------|----------|
| 5 | Adm | ✅ Puede usar comandos |
| 4 | Adm | ✅ Puede usar comandos |
| 3 | Mod | ✅ Puede usar comandos |
| 2 | Reg+ | ❌ Sin permisos |
| 1 | Reg | ❌ Sin permisos |
| 0 | Guest | ❌ Sin permisos |

## 🔍 Logs del Sistema

Todos los comandos generan logs detallados:

```bash
🎛️ [MOD-CONTROL] Comando recibido de Usuario (Mod): !pausar moderacion 30
⏸️ [MOD-CONTROL] Moderación PAUSADA por Usuario durante 30 minuto(s)
⏰ [MOD-CONTROL] Pausa de moderación expirada - REANUDANDO automáticamente
▶️ [MOD-CONTROL] Moderación REANUDADA por Usuario
📊 [MOD-CONTROL] Estado consultado por Usuario: ACTIVA
```

## ⚙️ Configuración

Esta funcionalidad está siempre activa cuando el bot está funcionando. No requiere configuración adicional en el `.env`.

## 🚨 Notas Importantes

1. **Solo moderadores/admins**: Otros usuarios que intenten usar comandos serán ignorados
2. **Sintaxis flexible**: Los comandos aceptan variaciones (`!pausar`, `!pausa`, etc.)
3. **Tiempo por defecto**: Si no se especifica tiempo, se usa 30 minutos
4. **Auto-reanudación**: El bot se reanuda automáticamente al cumplirse el tiempo
5. **Estado persistente**: El estado se mantiene durante reconexiones del bot