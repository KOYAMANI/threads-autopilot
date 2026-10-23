/** note 記事（SPEC §7.10）。`api/ai.ts` と同じ形のフック。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateNoteRequest,
  NoteDetail,
  NoteItemResponse,
  NoteListResponse,
  NoteOutlineRequest,
  NoteOutlineResponse,
  NoteReviseRequest,
  NoteSectionResponse,
  NoteSummary,
  PatchNoteRequest,
} from "@tap/shared";
import { api } from "./client";

export const notesKey = (accountId: string | null) => ["notes", "list", accountId] as const;
export const noteKey = (id: string | null) => ["notes", "item", id] as const;

export function useNotes(accountId: string | null) {
  return useQuery({
    queryKey: notesKey(accountId),
    enabled: accountId !== null,
    queryFn: async () => (await api.get<NoteListResponse>(`/notes?accountId=${encodeURIComponent(accountId!)}`)).notes,
  });
}

/** 書いている途中は3秒ごとに読み直す（章が届くのを待つ）。 */
export function useNote(id: string | null) {
  return useQuery({
    queryKey: noteKey(id),
    enabled: id !== null,
    queryFn: async () => (await api.get<NoteItemResponse>(`/notes/${id}`)).note,
    refetchInterval: (q) => (q.state.data?.status === "writing" ? 3000 : false),
  });
}

function useNoteWrite<TVars>(run: (vars: TVars) => Promise<NoteDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (note) => {
      qc.setQueryData(noteKey(note.id), note);
      void qc.invalidateQueries({ queryKey: notesKey(note.accountId) });
    },
  });
}

export function useCreateNote() {
  return useNoteWrite((body: CreateNoteRequest) => api.post<NoteItemResponse>("/notes", body).then((r) => r.note));
}

export function usePatchNote() {
  return useNoteWrite(({ id, ...body }: PatchNoteRequest & { id: string }) => api.patch<NoteItemResponse>(`/notes/${id}`, body).then((r) => r.note));
}

export function useDeleteNote(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/notes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKey(accountId) }),
  });
}

export function useNoteOutline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: NoteOutlineRequest & { id: string }) => api.post<NoteOutlineResponse>(`/notes/${id}/outline`, body),
    onSuccess: (res, vars) => {
      if (res.status === "ok") {
        qc.setQueryData(noteKey(res.note.id), res.note);
        void qc.invalidateQueries({ queryKey: notesKey(res.note.accountId) });
      } else {
        // 質問は qa_json に積まれている。読み直して画面に出す
        void qc.invalidateQueries({ queryKey: noteKey(vars.id) });
      }
    },
  });
}

export function useStartNote() {
  return useNoteWrite(({ id, resume }: { id: string; resume?: boolean }) => api.post<NoteItemResponse>(`/notes/${id}/write`, { resume: Boolean(resume) }).then((r) => r.note));
}

export function useCancelNote() {
  return useNoteWrite((id: string) => api.post<NoteItemResponse>(`/notes/${id}/cancel`, {}).then((r) => r.note));
}

export function useReviseSection(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionId, instruction }: NoteReviseRequest & { sectionId: string }) =>
      api.post<NoteSectionResponse>(`/notes/${noteId}/sections/${sectionId}/revise`, { instruction }).then((r) => r.section),
    onSuccess: (section) => {
      qc.setQueryData<NoteDetail | undefined>(noteKey(noteId), (prev) =>
        prev ? { ...prev, sections: prev.sections.map((s) => (s.id === section.id ? section : s)) } : prev,
      );
    },
  });
}

export function useRewriteSection(noteId: string) {
  return useNoteWrite((sectionId: string) => api.post<NoteItemResponse>(`/notes/${noteId}/sections/${sectionId}/rewrite`, {}).then((r) => r.note));
}

export type { NoteSummary };
