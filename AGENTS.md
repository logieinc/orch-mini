# AGENTS.md - orch-mini Repository

Este repositorio contiene el código fuente de `orch-mini` (el ejecutable CLI global `om`), un orquestador declarativo mínimo escrito en TypeScript para Docker Compose y Nginx.

---

## 🛠️ Entorno de Desarrollo y Flujo Operativo

> [!IMPORTANT]
> El CLI de `om` se ejecuta de forma directa y sin pre-compilación usando `tsx` (TypeScript Execute). Cualquier cambio realizado en el código fuente de `./src` se ve reflejado en tiempo real sin necesidad de generar una compilación intermedia.

### Configuración del Entorno de Desarrollo Local
Para trabajar en el desarrollo de `om`:

```bash
# 1. Instalar dependencias
npm install

# 2. Registrar el comando `om` globalmente vinculándolo a este checkout local
npm link

# 3. Validar los tipos de TypeScript sin emitir archivos
npm run typecheck
```

---

## 📂 Estructura y Puntos de Entrada del Código

*   **Punto de entrada del CLI:** [src/cli.ts](file:///Users/fabian/dev/orch-mini/src/cli.ts) (parsea argumentos y enruta los comandos `init`, `sync`, `gen`, `up`, `stop`, `down`, etc.).
*   **Enlace binario de ejecución:** [bin/om.cjs](file:///Users/fabian/dev/orch-mini/bin/om.cjs) (script de shim que carga el loader `tsx/cjs` y ejecuta directamente el archivo TypeScript del CLI).
*   **Ejemplos de stack declarativo:** Directorio [examples/](file:///Users/fabian/dev/orch-mini/examples/) para pruebas simples de sintaxis.

---

## ⚠️ Reglas de Validación
*   **Seguridad de tipado:** Siempre ejecuta `npm run typecheck` antes de dar por finalizado cualquier cambio en los fuentes de TypeScript para certificar que no haya regresiones o tipos rotos.
