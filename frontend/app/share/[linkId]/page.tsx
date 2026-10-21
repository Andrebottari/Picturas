"use client";

import { use, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { resolveShareLink } from "@/lib/projects";
import { useSession } from "@/providers/session-provider";

type Props = {
  params: Promise<{ linkId: string }>;
};

type ShareInfo = {
  projectId: string;
  ownerId: string;
  permission: "read" | "edit";
  projectName?: string;
  isVideo?: boolean;
};

export default function SharePage({ params }: Props) {
  const { linkId } = use(params);
  const router = useRouter();
  const session = useSession();
  const isAuthed = session.user.type !== "anonymous";

  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"invalid" | "service" | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function validateAndRedirect() {
      setLoading(true);
      try {
        // Validar sempre a partilha no servidor antes de encaminhar.
        const share = await resolveShareLink(linkId);
        if (cancelled) return;
        setInfo(share);
        setError(null);

        if (isAuthed) {
          const target = `/dashboard/${encodeURIComponent(share.projectId)}` +
            `?owner=${encodeURIComponent(share.ownerId)}` +
            `&share=${encodeURIComponent(linkId)}` +
            (share.isVideo ? "&editor=video" : "");
          router.replace(target);
        }
      } catch (err) {
        if (cancelled) return;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        setInfo(null);
        setError(status === 404 || status === 410 ? "invalid" : "service");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    validateAndRedirect();
    return () => { cancelled = true; };
  }, [linkId, isAuthed, router]);

  if (error === "invalid") {
    return (
      <main className="p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Link inválido ou revogado</h1>
        <p>Esta partilha já não está disponível.</p>
        <Link href="/dashboard" className="underline text-blue-500">Voltar ao Dashboard</Link>
      </main>
    );
  }

  if (error === "service") {
    return (
      <main className="p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Não foi possível verificar a partilha</h1>
        <p>Não foi possível contactar o serviço de partilhas. O link pode continuar válido.</p>
        <button type="button" className="underline text-blue-500" onClick={() => window.location.reload()}>
          Tentar novamente
        </button>
      </main>
    );
  }

  if (loading || (info && isAuthed)) {
    return (
      <main className="p-8 flex items-center justify-center" role="status" aria-live="polite">
        <span className="animate-spin mr-2" aria-hidden="true">⏳</span>
        <span>A abrir projeto partilhado…</span>
      </main>
    );
  }

  if (!info) {
    return <main className="p-8" role="status">A verificar partilha…</main>;
  }

  // Convidados sem sessão: autenticar primeiro, regressando ao editor diretamente.
  const target = `/dashboard/${encodeURIComponent(info.projectId)}` +
    `?owner=${encodeURIComponent(info.ownerId)}` +
    `&share=${encodeURIComponent(linkId)}` +
    (info.isVideo ? "&editor=video" : "");
  const next = encodeURIComponent(target);

  return (
    <main className="p-8 space-y-4">
      <h1 className="text-2xl font-semibold">Inicia sessão para abrir a partilha</h1>
      <p className="text-sm text-muted-foreground">
        Este projeto foi partilhado contigo com permissão de {info.permission === "edit" ? "edição" : "leitura"}.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href={`/login?next=${next}`} className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white text-sm">
          Iniciar sessão
        </Link>
        <Link href={`/register?next=${next}`} className="inline-flex items-center rounded border border-border px-4 py-2 text-sm">
          Criar conta
        </Link>
      </div>
    </main>
  );
}
