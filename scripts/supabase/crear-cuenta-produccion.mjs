import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRef = "nuxjojhynydmizqaigja";
const projectUrl = `https://${projectRef}.supabase.co`;
const email = process.env.RFIDTIMING_SUPABASE_EMAIL;
let password = process.env.RFIDTIMING_INITIAL_PASSWORD;
delete process.env.RFIDTIMING_INITIAL_PASSWORD;

if (!email || !password) {
  console.error("Faltan el correo o la contraseña. Ejecuta 02-crear-cuenta-produccion.ps1.");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..", "..");
const pnpmStore = path.join(appRoot, "node_modules", ".pnpm");

function findSupabaseCli() {
  let packages;
  try {
    packages = readdirSync(pnpmStore, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("supabase@"))
      .map((entry) => entry.name);
  } catch {
    throw new Error("No encontré la instalación local de Supabase CLI. Ejecuta pnpm install.");
  }

  for (const packageName of packages) {
    const candidate = path.join(pnpmStore, packageName, "node_modules", "supabase", "dist", "supabase.js");
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("No encontré el ejecutable local de Supabase CLI.");
}

function extractElevatedKey(payload) {
  const matches = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const label = [value.name, value.type, value.key_type, value.keyType, value.id]
      .filter((part) => typeof part === "string")
      .join(" ")
      .toLowerCase();
    const candidate = [value.api_key, value.apiKey, value.key, value.value]
      .find((part) => typeof part === "string");

    if (candidate?.startsWith("sb_secret_")) {
      matches.push({ score: 100, key: candidate });
    } else if (candidate?.startsWith("eyJ") && /service.?role|secret/.test(label)) {
      matches.push({ score: 80, key: candidate });
    }

    for (const child of Object.values(value)) visit(child);
  };

  visit(payload);
  matches.sort((left, right) => right.score - left.score);
  return matches[0]?.key;
}

function getProjectKey() {
  const cliPath = findSupabaseCli();
  const cliEnv = { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" };
  delete cliEnv.RFIDTIMING_INITIAL_PASSWORD;

  const result = spawnSync(process.execPath, [
    cliPath,
    "projects",
    "api-keys",
    "--reveal",
    "--project-ref",
    projectRef,
    "--output",
    "json",
  ], {
    cwd: appRoot,
    encoding: "utf8",
    env: cliEnv,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    const detail = (result.stderr || "").trim().replace(/(?:sb_secret_|eyJ)[A-Za-z0-9._-]+/g, "[clave oculta]");
    throw new Error(
      `Supabase CLI no pudo leer las claves del proyecto (${result.status ?? "sin código de salida"}). ` +
      (detail || "Confirma que ejecutaste 01-login-cli.ps1 y que tu cuenta tiene permisos sobre el proyecto.")
    );
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Supabase CLI devolvió una respuesta inesperada al consultar las claves.");
  } finally {
    result.stdout = "";
  }

  const key = extractElevatedKey(payload);
  if (!key) {
    throw new Error("No encontré una clave administrativa revelada. Revisa permisos de lectura de API Keys en Supabase.");
  }
  return key;
}

async function findUserByEmail(client, targetEmail) {
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`No se pudo revisar si la cuenta ya existe: ${error.message}`);
    const user = data.users.find((item) => item.email?.toLowerCase() === targetEmail.toLowerCase());
    if (user) return user;
    if (data.users.length < perPage) return null;
  }
}

try {
  const key = getProjectKey();
  const client = createClient(projectUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const existingUser = await findUserByEmail(client, email);
  if (existingUser?.email_confirmed_at || existingUser?.confirmed_at) {
    console.log(`La cuenta ${email} ya existe y está confirmada. No se cambió su contraseña.`);
    process.exitCode = 0;
  } else if (existingUser) {
    const { data, error } = await client.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`No se pudo activar la cuenta existente: ${error.message}`);
    console.log(`Cuenta existente activada para ${data.user.email}. Ya puede iniciar sesión.`);
  } else {
    const { data, error } = await client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`No se pudo crear la cuenta: ${error.message}`);
    console.log(`Cuenta creada y confirmada para ${data.user.email}. Ya puede iniciar sesión.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falló la provisión de la cuenta.");
  process.exitCode = 1;
} finally {
  password = "";
}
