import {
  AirplaneTilt,
  Article,
  Briefcase,
  Certificate,
  Exam,
  FileAudio,
  FileCsv,
  FileDoc,
  File as FileBlank,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  FileXls,
  FolderSimple,
  GraduationCap,
  IdentificationCard,
  LinkSimple,
  Note,
  PaperPlaneTilt,
  RocketLaunch,
  Trophy,
  UserCircle,
  type Icon,
} from "@phosphor-icons/react";

// One Phosphor icon per note type and file kind (DESIGN.md, Icons). Types not listed get a plain note.
const TYPES: Readonly<Record<string, Icon>> = {
  Education: GraduationCap,
  TestScore: Exam,
  Role: Briefcase,
  Paper: Article,
  Project: RocketLaunch,
  Award: Trophy,
  Certificate: Certificate,
  Trip: AirplaneTilt,
  IdDocument: IdentificationCard,
  Person: UserCircle,
  Profile: LinkSimple,
  Application: PaperPlaneTilt,
  Letter: FileText,
  Folder: FolderSimple,
};

export const typeIcon = (type: string): Icon => TYPES[type] ?? Note;

/** The icon for a file by its media type. */
export function fileIcon(mime: string): Icon {
  if (mime === "application/pdf") return FilePdf;
  if (mime === "text/csv") return FileCsv;
  if (mime.endsWith("spreadsheetml.sheet")) return FileXls;
  if (mime.endsWith("wordprocessingml.document")) return FileDoc;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.startsWith("text/")) return FileText;
  return FileBlank;
}
