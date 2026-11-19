# Crear la cuenta de producción

Estos scripts crean o activan la cuenta de Auth `operador@resultadospv.com` en el proyecto de producción `nuxjojhynydmizqaigja`.

1. Abre PowerShell en la carpeta `web-cronometraje`.
2. Ejecuta `powershell -ExecutionPolicy Bypass -File .\scripts\supabase\01-login-cli.ps1` y completa el inicio de sesión de Supabase CLI. El token se ingresa únicamente en esa consola y lo administra la CLI.
3. Ejecuta `powershell -ExecutionPolicy Bypass -File .\scripts\supabase\02-crear-cuenta-produccion.ps1`.
4. Ingresa la contraseña dos veces cuando se solicite. La consola no la mostrará.

El segundo script consulta la clave administrativa usando la CLI y la mantiene en memoria durante la operación. No la imprime ni la guarda en archivos. La contraseña tampoco se escribe en archivos. La cuenta nueva queda confirmada y lista para iniciar sesión. Si ya existe una cuenta confirmada, el script conserva su contraseña; si existe una invitación pendiente, la activa con la contraseña ingresada.

Supabase Auth no tiene un rol global de administrador en esta aplicación: la cuenta accede a los eventos según las reglas actuales de propiedad y autenticación.
