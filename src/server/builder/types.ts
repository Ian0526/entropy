/** Builder: plain-words change requests and questions, worked by a coding agent on the owner's PC. */

export type RequestStatus =
  | 'queued'
  | 'running'
  /** Finished with a code change to approve. */
  | 'proposed'
  /** Finished with nothing to approve, such as an answered question. */
  | 'done'
  | 'merge_queued'
  | 'merging'
  /** Approved and pushed, which deploys it. */
  | 'applied'
  | 'failed'
  | 'cancelled';

export interface BuilderMessage {
  role: 'person' | 'builder';
  text: string;
  at: number;
}

export interface BuilderImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface CodeProposal {
  branch: string;
  files: string[];
  checks: string;
}

/** One request as stored. Photos and screenshots live beside it on disk, counted here. */
export interface RequestRow {
  id: string;
  status: RequestStatus;
  title: string;
  messages: BuilderMessage[];
  progress: string[];
  imageTypes: BuilderImage['mediaType'][];
  /** PNG screenshots of the change, taken from a local build. */
  shotCount: number;
  proposal: CodeProposal | null;
  sessionId: string | null;
  costUsd: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

export type BuilderJob =
  | { kind: 'run'; id: string; prompt: string; sessionId: string | null; images: BuilderImage[]; branch: string }
  | { kind: 'merge'; id: string; branch: string };

export const branchFor = (id: string) => `agent/${id}`;

/** What the page polls. */
export type RequestSummary = Omit<RequestRow, 'imageTypes'> & { hasImages: boolean };
