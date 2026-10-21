"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  Check, CheckCircle2, CircleAlert, Clapperboard, Clock3,
  Film, LoaderCircle, Play, RotateCcw, SlidersHorizontal,
  Sparkles, UploadCloud, Video, X, Download,
} from "lucide-react";
import { api } from "@/lib/axios";
import { retirarVideoPendente } from "@/lib/pending-video";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

//AB UC-03: editor de vídeo independente do editor de imagens.
type FilterName = "cinzento" | "brilho" | "contraste" | "saturacao";
type Filter = { name: FilterName; value?: number };
type ProcessState = {
  processId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  progress?: number;
  outputVideoKey?: string | null;
  errorMessage?: string | null;
  filters?: Filter[];
};

const ranges: Record<Exclude<FilterName, "cinzento">, { min: number; max: number; step: number; initial: number }> = {
  brilho: { min: -1, max: 1, step: 0.1, initial: 0.2 },
  contraste: { min: 0, max: 2, step: 0.1, initial: 1.2 },
  saturacao: { min: 0, max: 3, step: 0.1, initial: 1.3 },
};
const filtersInfo: { name: FilterName; label: string; description: string }[] = [
  { name: "cinzento", label: "Preto e branco", description: "Converte a imagem para tons de cinzento" },
  { name: "brilho", label: "Brilho", description: "Ajusta a luminosidade do vídeo" },
  { name: "contraste", label: "Contraste", description: "Realça a diferença entre tons claros e escuros" },
  { name: "saturacao", label: "Saturação", description: "Ajusta a intensidade das cores" },
];

function errorText(err: unknown) {
  if (axios.isAxiosError(err)) {
    const value = err.response?.data?.message;
    return typeof value === "string" ? value : err.message;
  }
  return err instanceof Error ? err.message : "Ocorreu um erro inesperado.";
}
function displaySize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const statusLabel: Record<ProcessState["status"], string> = {
  pending: "Na fila", processing: "A processar", completed: "Concluído",
  failed: "Falhou", cancelled: "Cancelado",
};

export function VideoFiltersPanel({ userId, projectId, token, version, onUploaded, shareId, canModify = true }: {
  userId: string;
  projectId: string;
  token: string;
  version: number;
  onUploaded: () => Promise<unknown> | void;
  shareId?: string;
  canModify?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [storedPreviewUrl, setStoredPreviewUrl] = useState<string | null>(null);
  const [originalBusy, setOriginalBusy] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [savedOriginal, setSavedOriginal] = useState<{ name: string; sizeBytes: number; durationSeconds: number } | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [duration, setDuration] = useState<number | null>(null);
  const [selected, setSelected] = useState<FilterName[]>(["cinzento"]);
  const [values, setValues] = useState<Record<string, number>>({
    brilho: ranges.brilho.initial,
    contraste: ranges.contraste.initial,
    saturacao: ranges.saturacao.initial,
  });
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [state, setState] = useState<ProcessState | null>(null);
  const [notice, setNotice] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const resultUrlRef = useRef<string | null>(null);
  const autoLoadedProcessRef = useRef<string | null>(null);
  const storedPreviewUrlRef = useRef<string | null>(null);
  const currentVersion = useRef(version);
  const alive = useRef(true);
  const localSelection = useRef(false);
  const base = `projects/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/video`;
  const headers = { Authorization: `Bearer ${token}` };
  const shareQuery = shareId ? `?share=${encodeURIComponent(shareId)}` : "";
  const running = !!state && ["pending", "processing"].includes(state.status);
  // Só permitir descarregar um MP4 realmente processado com os filtros
  // atualmente selecionados. Um processamento restaurado também conta.
  const appliedFilters = state?.filters ?? [];
  const filtersMatchLastProcess =
    appliedFilters.length === selected.length &&
    selected.every(name => {
      const applied = appliedFilters.find(filter => filter.name === name);
      if (!applied) return false;
      return name === "cinzento" || (applied.value != null && Math.abs(applied.value - values[name]) < 0.00001);
    });
  const canDownload = !restoring && !busy && !running &&
    state?.status === "completed" && filtersMatchLastProcess && !!state.outputVideoKey;

  //AB Pré-visualização rápida aproximada em CSS; o processamento final usa FFmpeg.
  const previewFilter = compareOriginal ? "none" : [
    selected.includes("cinzento") ? "grayscale(1)" : "",
    selected.includes("brilho") ? `brightness(${Math.max(0, 1 + values.brilho)})` : "",
    selected.includes("contraste") ? `contrast(${values.contraste})` : "",
    selected.includes("saturacao") ? `saturate(${values.saturacao})` : "",
  ].filter(Boolean).join(" ") || "none";

  useEffect(() => { currentVersion.current = version; }, [version]);
  //AB O MP4 escolhido no Dashboard é disponibilizado ao editor sem novo seletor.
  useEffect(() => {
    const pending = canModify && !shareId ? retirarVideoPendente() : null;
    if (pending) chooseFile(pending);
    // Executar apenas ao abrir este editor, preservando o ficheiro local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => () => {
    alive.current = false;
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    if (storedPreviewUrlRef.current) URL.revokeObjectURL(storedPreviewUrlRef.current);
  }, []);

  // UC-03: fonte de verdade = MongoDB, nao localStorage. Repor filtros e
  // permitir descarregar o MP4 depois de fechar/reabrir o navegador.
  useEffect(() => {
    let active = true;
    setRestoring(true);
    api.get<{ original: { name: string; sizeBytes: number; durationSeconds: number } | null; process: ProcessState | null }>(
      `${base}/saved${shareQuery}`, { headers }
    ).then(response => {
      if (!active) return;
      if (!localSelection.current) setSavedOriginal(response.data.original);
      // Um original previamente guardado pode ser mostrado sem o ficheiro local.
      // Nao sobrepor um MP4 que o utilizador acabou de escolher.
      if (response.data.original && !localSelection.current) {
        setOriginalBusy(true);
        api.get<Blob>(`${base}/original${shareQuery}`, { headers, responseType: "blob", timeout: 180000 })
          .then(originalResponse => {
            if (!active || localSelection.current) return;
            const blob = originalResponse.data;
            if (!blob || blob.size === 0) throw new Error("O video original esta vazio.");
            const objectUrl = URL.createObjectURL(new Blob([blob], { type: "video/mp4" }));
            if (storedPreviewUrlRef.current) URL.revokeObjectURL(storedPreviewUrlRef.current);
            storedPreviewUrlRef.current = objectUrl;
            setStoredPreviewUrl(objectUrl);
          })
          .catch(err => { if (active) setError(`Nao foi possivel apresentar o video original: ${errorText(err)}`); })
          .finally(() => { if (active) setOriginalBusy(false); });
      }
      const saved = response.data.process;
      if (saved && !localSelection.current) {
        setState(saved);
        if (saved.filters?.length) {
          setSelected(saved.filters.map(f => f.name));
          setValues(old => {
            const next = { ...old };
            for (const f of saved.filters ?? []) {
              if (f.value != null) next[f.name] = f.value;
            }
            return next;
          });
        }
        if (saved.status === "completed") setNotice("Processamento anterior guardado. Podes ver ou descarregar o MP4 sem processar novamente.");
      }
    }).catch(err => {
      if (active) setError(`Nao foi possivel recuperar o projeto guardado: ${errorText(err)}`);
    }).finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
    // Revalidar quando muda a conta/projeto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, userId, token]);

  function clearResult() {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = null;
    setResultUrl(null);
  }

  //AB Fetch com JWT, nunca expor segredo S3 no browser.
  async function getResult(): Promise<string | null> {
    if (!state || state.status !== "completed") return null;
    if (resultUrlRef.current) return resultUrlRef.current;
    setResultBusy(true); setError("");
    try {
      const response = await api.get<Blob>(`${base}/process/${encodeURIComponent(state.processId)}/result${shareQuery}`, {
        headers, responseType: "blob", timeout: 180000,
      });
      const blob = response.data;
      if (!blob || blob.size === 0) throw new Error("O resultado recebido está vazio.");
      const url = URL.createObjectURL(new Blob([blob], { type: "video/mp4" }));
      resultUrlRef.current = url;
      return url;
    } catch (err) {
      setError(`Falha ao obter o vídeo processado: ${errorText(err)}`);
      return null;
    } finally { setResultBusy(false); }
  }

  //AB Transferir o MP4 não deve abrir outro leitor nem mudar o layout.
  async function downloadResult() {
    if (!canDownload || !state) return;
    const url = await getResult();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `picturas-${state.processId}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Apresentar automaticamente o MP4 final quando há um processamento concluído.
  // Caso o armazenamento esteja indisponível, manter o original e mostrar o erro:
  // uma pré-visualização CSS não pode ser apresentada como exportação FFmpeg.
  useEffect(() => {
    if (restoring || !state || state.status !== "completed") return;
    if (autoLoadedProcessRef.current === state.processId) return;
    autoLoadedProcessRef.current = state.processId;
    let active = true;
    void getResult().then(url => {
      if (active && url) setResultUrl(url);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring, state?.processId, state?.status]);


  useEffect(() => {
    if (!state || !running) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await api.get<ProcessState>(`${base}/process/${encodeURIComponent(state.processId)}${shareQuery}`, { headers });
        if (!stopped && alive.current) {
          setState(response.data);
          if (response.data.status === "completed") setNotice("Processamento concluído. O vídeo foi guardado no projeto.");
        }
      } catch (err) {
        if (!stopped && alive.current) setError(`Não foi possível consultar o estado: ${errorText(err)}`);
      }
    }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [base, state?.processId, state?.status, token, running]);

  function chooseFile(next: File | null) {
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".mp4") || (next.type && next.type !== "video/mp4")) {
      setError("O formato suportado é MP4 com codec H.264. Ficheiros MKV ainda não são suportados.");
      return;
    }
    if (next.size > 500 * 1024 * 1024) {
      setError("O vídeo não pode exceder 500 MB.");
      return;
    }
    localSelection.current = true;
    autoLoadedProcessRef.current = null;
    clearResult(); setError(""); setNotice(""); setFile(next); setUploadedFile(null); setState(null); setDuration(null);
    if (storedPreviewUrlRef.current) URL.revokeObjectURL(storedPreviewUrlRef.current);
    storedPreviewUrlRef.current = null;
    setStoredPreviewUrl(null);
  }
  function toggleFilter(name: FilterName) {
    setResultUrl(null);
    setSelected(old => old.includes(name) ? old.filter(item => item !== name) : [...old, name]);
  }
  function resetFilters() {
    setResultUrl(null);
    setSelected(["cinzento"]);
    setValues({ brilho: ranges.brilho.initial, contraste: ranges.contraste.initial, saturacao: ranges.saturacao.initial });
  }

  //AB Upload reutilizado: "Aplicar filtros" também carrega o MP4 se ainda for local.
  async function uploadToServer(videoFile: File) {
    const form = new FormData();
    form.append("file", videoFile);
    const result = await api.post(`${base}`, form, {
      headers: { ...headers, "X-Project-Version": String(currentVersion.current) },
      timeout: 180000,
    });
    const newVersion = Number(result.data?.projectVersion ?? result.headers["x-project-version"]);
    if (Number.isFinite(newVersion)) currentVersion.current = newVersion;
    autoLoadedProcessRef.current = null;
    setUploadedFile(videoFile.name);
    setSavedOriginal({ name: videoFile.name, sizeBytes: videoFile.size, durationSeconds: duration ?? 0 });
    clearResult();
    setState(null);

    await onUploaded();
  }

  async function upload() {
    if (!file || busy || running || uploadedFile === file.name) return;
    setBusy(true); setError(""); setNotice("A carregar vídeo...");
    try {
      await uploadToServer(file);
      setNotice("Vídeo carregado. Podes aplicar os filtros.");
    } catch (err) { setNotice(""); setError(`Falha ao carregar o vídeo: ${errorText(err)}`); }
    finally { setBusy(false); }
  }

  async function processVideo() {
    if (!canModify || (!file && !savedOriginal) || busy || running || originalBusy) return;
    if (!selected.length) { setError("Seleciona pelo menos um filtro."); return; }
    setBusy(true); setError(""); setNotice("");
    const filters: Filter[] = selected.map(name => name === "cinzento" ? { name } : { name, value: values[name] });
    //AB Evitar publicar um trabalho se o carregamento do vídeo falhar.
    if (file && uploadedFile !== file.name) {
      try {
        setNotice("A carregar vídeo antes de aplicar os filtros...");
        await uploadToServer(file);
      } catch (err) {
        setNotice("");
        setError(`Não foi possível carregar o vídeo: ${errorText(err)}`);
        setBusy(false);
        return;
      }
    }
    setNotice("A enviar o processamento...");
    try {
      const response = await api.post<ProcessState>(`${base}/process${shareQuery}`, { filters }, {
        headers: { ...headers, "X-Project-Version": String(currentVersion.current) },
        timeout: 180000,
      });
      autoLoadedProcessRef.current = null;
      clearResult();
      setState(response.data);

      setNotice("Pedido enviado. O estado é atualizado automaticamente.");
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.data?.publicationUncertain && err.response.data.processId) {
        setState({ processId: err.response.data.processId, status: "pending" });

        setNotice("Publicação por confirmar; vamos acompanhar o estado antes de repetir.");
      } else { setNotice(""); setError(errorText(err)); }
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (!state) return;
    setBusy(true); setError("");
    try {
      const result = await api.delete<ProcessState>(`${base}/process/${encodeURIComponent(state.processId)}${shareQuery}`, { headers });
      setState(old => old ? { ...old, status: result.data.status } : null);
      setNotice("Pedido cancelado no servidor.");
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <section aria-label="Editor de vídeo UC-03" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-background">
      {/* AB: cabeçalho compacto, no padrão das ferramentas do PictuRAS. */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Clapperboard className="size-5" /></span>
          <div className="min-w-0"><h2 className="font-semibold leading-tight">Editor de vídeo</h2><p className="text-xs text-muted-foreground">UC-03 · Filtros visuais · MP4 / H.264</p></div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border px-3 py-1.5">Até 500 MB</span>
          {(restoring || originalBusy) && <span role="status" className="text-xs">A recuperar vídeo...</span>}
          {state && <span role="status" className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 font-medium text-foreground">{statusLabel[state.status]}</span>}
        </div>
      </header>

      <div className="grid min-w-0 flex-none grid-cols-1 lg:grid-cols-[minmax(0,1fr)_310px] xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* AB: área de trabalho visual com proporção 16:9 e controlos nativos acessíveis. */}
        <main className="flex min-w-0 flex-col gap-4 bg-muted/20 p-4 md:p-6">
          <div className="flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Pré-visualização dos filtros</h3><p className="text-xs text-muted-foreground">Resultado aproximado em tempo real · exportação final por FFmpeg</p></div>{file && <span className="hidden rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground sm:inline">{displaySize(file.size)}</span>}</div>
          {/* AB Um único leitor responsivo, incluindo vídeos verticais: evitar sobreposição no rodapé. */}
          <div className="flex w-full min-w-0 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-zinc-950 p-3 shadow-sm">
            {resultUrl || previewUrl || storedPreviewUrl ? (
              <video key={resultUrl ?? previewUrl ?? storedPreviewUrl} className="block h-auto max-h-[55vh] w-full max-w-full rounded-md object-contain" style={{ filter: resultUrl ? "none" : previewFilter }} src={resultUrl ?? previewUrl ?? storedPreviewUrl ?? undefined} controls playsInline preload="metadata" aria-label={resultUrl ? "Reproduzir vídeo processado" : "Pré-visualização do vídeo original"} onLoadedMetadata={event => { if (!resultUrl) setDuration(event.currentTarget.duration); }} />
            ) : (
              <div className="flex max-w-sm flex-col items-center gap-3 text-center text-zinc-300"><span className="rounded-2xl bg-white/10 p-5"><Video className="size-10" /></span><p className="text-base font-medium text-white">O teu vídeo aparece aqui</p><p className="text-sm text-zinc-400">Escolhe um MP4 para pré-visualizar, configurar e aplicar os filtros.</p><Button type="button" variant="secondary" onClick={() => picker.current?.click()}><UploadCloud className="mr-2 size-4" />Selecionar MP4</Button></div>
            )}
          </div>
          {(previewUrl || storedPreviewUrl) && !resultUrl && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">Ajusta os filtros com o vídeo a reproduzir. A pré-visualização é aproximada e pode diferir do FFmpeg.</p>
            <Button type="button" size="sm" variant={compareOriginal ? "default" : "outline"}
              onPointerDown={() => setCompareOriginal(true)} onPointerUp={() => setCompareOriginal(false)}
              onPointerLeave={() => setCompareOriginal(false)} onPointerCancel={() => setCompareOriginal(false)}
              onKeyDown={event => { if (event.key === " " || event.key === "Enter") setCompareOriginal(true); }}
              onKeyUp={() => setCompareOriginal(false)}
            >Premir para comparar original</Button>
          </div>}
          <div className="rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted"><Film className="size-4" /></span>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{file?.name ?? savedOriginal?.name ?? "Nenhum vídeo selecionado"}</p><p className="text-xs text-muted-foreground">{file ? `${displaySize(file.size)}${duration != null && Number.isFinite(duration) ? ` · ${formatTime(duration)}` : ""}` : savedOriginal ? `${displaySize(savedOriginal.sizeBytes)} · ${formatTime(savedOriginal.durationSeconds)} · Guardado no projeto` : "Formato MP4/H.264 · máximo 500 MB"}</p></div>
              {uploadedFile === file?.name && <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-4" />Carregado</span>}
              <Button type="button" size="sm" variant="outline" disabled={!canModify || !!shareId || busy || running} onClick={() => picker.current?.click()}>{file || savedOriginal ? "Trocar vídeo" : "Escolher vídeo"}</Button>
            </div>
          </div>
          <div onDragOver={event => { if (canModify && !shareId && !busy && !running) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (canModify && !shareId && !busy && !running) chooseFile(event.dataTransfer.files[0] || null); }} className={`rounded-lg border border-dashed px-4 py-3 text-center text-xs text-muted-foreground transition-colors ${dragging ? "border-primary bg-primary/5" : "border-border"}`}>
            <UploadCloud className="mr-2 inline size-4" /> Também podes arrastar um vídeo MP4 para aqui
          </div>
        </main>

        {/* AB: parâmetros sempre visíveis, agrupados e identificados. */}
        <aside className="min-w-0 border-t bg-card lg:border-l lg:border-t-0">
          <div className="sticky top-0 flex items-center gap-2 border-b bg-card px-5 py-4"><SlidersHorizontal className="size-4 text-primary" /><h3 className="text-sm font-semibold">Ajustar filtros</h3><span className="ml-auto text-xs text-muted-foreground">{selected.length} ativos</span></div>
          <fieldset className="space-y-3 p-4" disabled={!canModify || busy || running}>
            <legend className="sr-only">Escolher filtros de vídeo</legend>
            {filtersInfo.map(item => {
              const active = selected.includes(item.name);
              return <div key={item.name} className={`rounded-xl border p-3 transition-colors ${active ? "border-primary/40 bg-primary/5" : "bg-background"}`}>
                <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" className="mt-1 size-4 accent-blue-500" checked={active} onChange={() => toggleFilter(item.name)} /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.label}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{item.description}</span></span>{active && <Check className="size-4 shrink-0 text-primary" />}</label>
                {active && item.name !== "cinzento" && <div className="mt-3 border-t pt-3"><div className="mb-1.5 flex justify-between text-xs text-muted-foreground"><span>Intensidade</span><output className="font-medium tabular-nums text-foreground">{values[item.name].toFixed(1)}</output></div><input className="w-full accent-blue-500" aria-label={`Valor de ${item.label}`} type="range" min={ranges[item.name].min} max={ranges[item.name].max} step={ranges[item.name].step} value={values[item.name]} onChange={event => { setResultUrl(null); setValues(old => ({ ...old, [item.name]: Number(event.target.value) })); }} /><div className="flex justify-between text-[11px] text-muted-foreground"><span>{ranges[item.name].min}</span><span>{ranges[item.name].max}</span></div></div>}
              </div>;
            })}
            <Button type="button" variant="ghost" size="sm" onClick={resetFilters} className="w-full text-muted-foreground"><RotateCcw className="mr-2 size-3.5" />Repor filtros</Button>
          </fieldset>
          <div className="mx-4 mb-4 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground"><Sparkles className="mb-1 inline size-4 text-primary" /> Os efeitos nesta pré-visualização são aproximados. O FFmpeg aplica os ajustes ao vídeo completo quando iniciares o processamento.</div>
        </aside>
      </div>

      <footer className="shrink-0 border-t bg-card px-4 pb-8 pt-4 md:px-6 md:pb-8">
        {state && <div className="mb-3 space-y-2"><div className="flex items-center justify-between text-xs"><span className="inline-flex items-center gap-2 font-medium">{running ? <LoaderCircle className="size-3.5 animate-spin" /> : state.status === "completed" ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Clock3 className="size-3.5" />}{statusLabel[state.status]}</span>{typeof state.progress === "number" && <span className="tabular-nums text-muted-foreground">{state.progress}%</span>}</div><Progress value={typeof state.progress === "number" ? state.progress : running ? 12 : state.status === "completed" ? 100 : 0} className="h-1.5" /></div>}
        {error && <p className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {state?.status === "failed" && <p className="mb-3 text-sm text-destructive" role="alert">{state.errorMessage || "O processamento falhou."}</p>}

        {notice && <p className="mb-3 text-xs text-muted-foreground" role="status">{notice}</p>}
        {!canModify && <p className="mb-3 text-xs text-muted-foreground" role="status">Acesso apenas de leitura: podes reproduzir e descarregar o vídeo.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-muted-foreground"><span className="font-medium text-foreground">1.</span> Escolher vídeo <span className="mx-1">→</span> <span className="font-medium text-foreground">2.</span> Ajustar filtros <span className="mx-1">→</span> <span className="font-medium text-foreground">3.</span> Aplicar (upload automático)</div><div className="flex flex-wrap items-center gap-2">{running && canModify && <Button type="button" variant="outline" disabled={busy} onClick={cancel}><X className="mr-2 size-4" />Cancelar</Button>}<Button type="button" variant="outline" disabled={!canDownload || resultBusy} aria-label="Descarregar vídeo processado" title={!canDownload ? "Aplica os filtros e aguarda a conclusão do processamento para descarregar" : "Descarregar vídeo processado"} onClick={() => void downloadResult()}><Download className="mr-2 size-4" />{resultBusy ? "A descarregar..." : "Descarregar"}</Button><Button type="button" disabled={!canModify || (!file && !savedOriginal) || !selected.length || busy || running || originalBusy} onClick={processVideo}>{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}Aplicar filtros</Button></div></div>
      </footer>
      <input ref={picker} type="file" accept=".mp4,video/mp4" className="sr-only" aria-label="Selecionar vídeo MP4" disabled={!canModify || !!shareId || busy || running} onChange={event => { chooseFile(event.target.files?.[0] || null); event.currentTarget.value = ""; }} />
    </section>
  );
}
