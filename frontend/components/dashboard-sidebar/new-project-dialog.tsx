import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAddProject } from "@/lib/mutations/projects";
import ImageSubmissionArea from "../image-submission-area";
import { useSession } from "@/providers/session-provider";
import { LoaderCircle, Film, Images } from "lucide-react";
import { useRouter } from "next/navigation";
import { getErrorMessage } from "@/lib/error-messages";
import { guardarVideoPendente } from "@/lib/pending-video";

type ProjectKind = "images" | "video";

export default function NewProjectDialog({
  files = [],
  setFiles,
  children,
  defaultKind = "images",
}: {
  defaultKind?: ProjectKind;
  files?: File[];
  setFiles?: (files: File[]) => void;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  //AB UC-03: criar um projeto para vídeo sem exigir imagens.
  const [kind, setKind] = useState<ProjectKind>(defaultKind);
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const session = useSession();
  const addProject = useAddProject(session.user._id, session.token);

  function handleCreate() {
    if (!name.trim() || addProject.isPending) return;
    if (kind === "images" && imageFiles.length === 0) return;
    if (kind === "video" && !videoFile) return;

    addProject.mutate(
      {
        uid: session.user._id,
        token: session.token,
        name: name.trim(),
        images: kind === "images" ? imageFiles : [],
      },
      {
        onSuccess: (project) => {
          if (kind === "video" && videoFile) guardarVideoPendente(videoFile);
          setOpen(false);
          toast({
            title: "Projeto criado com sucesso",
            description:
              kind === "video"
                ? "Abre o painel Filtros de vídeo para carregar um MP4."
                : "As imagens foram adicionadas ao novo projeto.",
          });
          if (project) router.push(`/dashboard/${project._id}${kind === "video" ? "?editor=video" : ""}`);
        },
        onError: (error) => {
          const { title, description } = getErrorMessage("project-create", error);
          toast({ title, description, variant: "destructive" });
        },
      },
    );
  }

  useEffect(() => {
    if (files.length > 0) {
      const video = files.length === 1 && /\.mp4$/i.test(files[0].name);
      setKind(video ? "video" : "images");
      setVideoFile(video ? files[0] : null);
      setOpen(true);
    }
  }, [files]);

  useEffect(() => {
    if (!open) {
      setName("");
      setImageFiles([]);
      setVideoFile(null);
      setKind(defaultKind);
      if (setFiles) setFiles([]);
    }
  }, [open, setFiles, defaultKind]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {setFiles ? children : <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <Label htmlFor="project-name">Project Name</Label>
        <Input
          id="project-name"
          placeholder="Enter project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {/* AB O formato selecionado determina automaticamente o editor. */}
        <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
          {kind === "video" ? <Film className="size-4 text-primary" /> : <Images className="size-4 text-primary" />}
          <span>{kind === "video" ? "Projeto de vídeo MP4" : "Projeto de imagens"}</span>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Escolher ficheiro (imagem, ZIP ou vídeo MP4)</span>
          <Input type="file" accept=".png,.jpg,.jpeg,.zip,.mp4,image/png,image/jpeg,video/mp4,application/zip"
            onChange={event => {
              const item = event.target.files?.[0];
              if (!item) return;
              if (/\.mp4$/i.test(item.name)) { setKind("video"); setVideoFile(item); setImageFiles([]); }
              else { setKind("images"); setVideoFile(null); }
            }}
          />
        </label>
        {kind === "images" ? (
          <ImageSubmissionArea
            onDrop={(selectedFiles) => setImageFiles(selectedFiles)}
            receivedFiles={files}
          />
        ) : (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            {videoFile ? <>Vídeo selecionado: <strong>{videoFile.name}</strong>. Depois de criar o projeto, o ficheiro estará pronto para pré-visualização e filtros.</> : <>Seleciona um MP4 para criar um projeto de vídeo.</>}
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={
              addProject.isPending ||
              name.trim().length === 0 ||
              (kind === "images" && imageFiles.length === 0) ||
              (kind === "video" && !videoFile)
            }
            className="inline-flex items-center gap-1"
          >
            <span>Create</span>
            {addProject.isPending && <LoaderCircle className="size-[1em] animate-spin" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
