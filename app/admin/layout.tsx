import Link from "next/link";
import { redirect } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { createClient } from "@/lib/supabase/server";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return <div className="app-shell admin-ui">
    <header className="topbar">
      <Link href="/admin" className="brand"><span className="brand-mark">T</span> Resultados Ticketnexo <span className="brand-beta">PANEL</span></Link>
      <nav className="top-links"><Link href="/admin">Eventos</Link><span className="top-email">{user.email}</span>
        <form action={signOutAction}><button className="button button-quiet button-small">Salir</button></form>
      </nav>
    </header>
    <main className="workspace">{children}</main>
    <footer className="app-footer"><span>RESULTADOS TICKETNEXO · PANEL DE ORGANIZACIÓN</span><span>ACCESO RESTRINGIDO</span></footer>
  </div>;
}
