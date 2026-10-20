"use client";

import AppDropzone from "@/components/app-dropzone";
import NewProjectDialog from "@/components/dashboard-sidebar/new-project-dialog";
import { extractZipImages } from "@/lib/utils";
import { Film, Images, UploadCloud } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

//AB Uma única zona de importação: identificar vídeo ou imagens automaticamente.
export default function Dashboard() {
  const [files, setFiles] = useState<File[]>([]);
  const { toast } = useToast();

  async function handleDrop(acceptedFiles: File[]) {
    const videos = acceptedFiles.filter(file => file.name.toLowerCase().endsWith(".mp4"));
    const images = acceptedFiles.filter(file => /\.(jpe?g|png)$/i.test(file.name));
    const archives = acceptedFiles.filter(file => /\.zip$/i.test(file.name));
    if (videos.length) {
      if (acceptedFiles.length !== 1 || videos.length !== 1) {
        toast({ title: "Seleciona apenas um vídeo MP4 de cada vez.", variant: "destructive" });
        return;
      }
      setFiles([videos[0]]);
      return;
    }
    const expanded = [...images];
    for (const zip of archives) {
      try { expanded.push(...await extractZipImages(zip)); }
      catch { toast({ title: `Não foi possível abrir ${zip.name}`, variant: "destructive" }); }
    }
    if (expanded.length) setFiles(expanded);
  }

  return (
    <div className="h-full overflow-y-auto p-5 md:p-8">
      <div className="mx-auto flex h-full max-w-5xl flex-col gap-5">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold">Começar a editar</h1>
          <p className="text-muted-foreground">Escolhe ou arrasta um ficheiro. O PictuRAS identifica automaticamente se é uma imagem ou um vídeo.</p>
        </div>
        <div className="min-h-[360px] flex-1">
          <NewProjectDialog files={files} setFiles={setFiles}>
            <AppDropzone onDrop={handleDrop}>
              <div className="flex max-w-lg flex-col items-center gap-5 py-10">
                <div className="rounded-2xl bg-primary/10 p-5 text-primary"><UploadCloud className="size-11" /></div>
                <div><p className="text-xl font-semibold text-foreground">Arrasta um ficheiro ou clica para escolher</p>
                  <p className="mt-2 text-sm text-muted-foreground">O projeto será criado com o tipo adequado ao ficheiro.</p></div>
                <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1"><Images className="size-4" />PNG, JPG, ZIP</span>
                  <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1"><Film className="size-4" />MP4 / H.264</span>
                </div>
              </div>
            </AppDropzone>
          </NewProjectDialog>
        </div>
      </div>
    </div>
  );
}
