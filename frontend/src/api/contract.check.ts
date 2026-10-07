/**
 * Compile-time contract between the hand-written API types and the backend's own schema.
 *
 * `schema.d.ts` is generated from the backend's OpenAPI (`npm run gen:api`; both the snapshot and
 * the generated file are pinned by tests, see `schema.sync.test.ts`). The hand-written types stay
 * the ones the app uses, because they are often narrower than the backend says (a status the
 * backend declares as `string` is a union here). This file makes `npm run typecheck` fail when one
 * of them stops being a refinement of its backend schema:
 *
 * - a field the frontend declares that the backend does not have (renamed or removed on the
 *   backend, or a request field the backend would silently drop), or
 * - a field whose scalar type the backend's does not allow (`string` here, `number` there).
 *
 * Backend fields the frontend does not model are fine. Object-valued fields are not compared here:
 * each nested type has its own row below. Nothing imports this file, so it never reaches the bundle.
 */
import type * as Admin from "./admin";
import type * as Auth from "./auth";
import type * as Client from "./client";
import type * as Knowledge from "./personaKnowledge";
import type * as Personas from "./personas";
import type { components } from "./schema";

type Schemas = components["schemas"];

/** Array element type, then "object" for anything object-shaped (checked by its own row). */
type Leaf<T> = T extends readonly (infer E)[] ? Leaf<E> : T extends object ? "object" : T;

/** Shared fields whose frontend type the backend's type does not allow. */
type NotARefinement<Front, Back> = {
  [K in keyof Front & keyof Back]: Leaf<NonNullable<Back[K]>> extends "object"
    ? never
    : Leaf<NonNullable<Front[K]>> extends Leaf<NonNullable<Back[K]>>
      ? never
      : K;
}[keyof Front & keyof Back];

/** `true`, or an object naming exactly which fields broke the contract (shown in the tsc error). */
type Refines<Front, Back> = [Exclude<keyof Front, keyof Back>] extends [never]
  ? [NotARefinement<Front, Back>] extends [never]
    ? true
    : { notARefinement: NotARefinement<Front, Back> }
  : { onlyInFrontend: Exclude<keyof Front, keyof Back> };

type Holds<T extends true> = T;

export type ApiContract = [
  // Admin: question banks, rubrics, configuration, users
  Holds<Refines<Admin.Bank, Schemas["BankOut"]>>,
  Holds<Refines<Admin.AdminQuestion, Schemas["AdminQuestionOut"]>>,
  Holds<Refines<Admin.ChecklistItem, Schemas["ChecklistItemOut"]>>,
  Holds<Refines<Admin.Checklist, Schemas["ChecklistOut"]>>,
  Holds<Refines<Admin.AiFoundryConfig, Schemas["AiFoundryConfigOut"]>>,
  Holds<Refines<Admin.AiFoundryConfigInput, Schemas["AiFoundryConfigIn"]>>,
  Holds<Refines<Admin.ConnectionTestResult, Schemas["ConnectionTestResult"]>>,
  Holds<Refines<Admin.ConfigOption, Schemas["Option"]>>,
  Holds<Refines<Admin.ExternalConfig, Schemas["ExternalConfigOut"]>>,
  Holds<Refines<Admin.ExternalConfigInput, Schemas["ExternalConfigIn"]>>,
  Holds<Refines<Admin.AdminUser, Schemas["AdminUserResponse"]>>,
  Holds<Refines<Auth.CurrentUser, Schemas["UserResponse"]>>,
  // Personas and their knowledge
  Holds<Refines<Personas.PersonaOut, Schemas["PersonaOut"]>>,
  Holds<Refines<Personas.PersonaCreate, Schemas["PersonaCreate"]>>,
  Holds<Refines<Personas.PersonaUpdate, Schemas["PersonaUpdate"]>>,
  Holds<Refines<Knowledge.KbConnection, Schemas["KbConnectionOut"]>>,
  Holds<Refines<Knowledge.PersonaKnowledgeConfig, Schemas["PersonaKnowledgeOut"]>>,
  Holds<Refines<Knowledge.PersonaKnowledgeCreate, Schemas["PersonaKnowledgeCreate"]>>,
  Holds<Refines<Knowledge.TestChatReply, Schemas["TestChatOut"]>>,
  // Candidate interview. The report's per-question entries are untyped dicts on the backend, so
  // only the report's top level is checked.
  Holds<Refines<Client.Question, Schemas["CurrentQuestionOut"]>>,
  Holds<Refines<Client.Interview, Schemas["InterviewOut"]>>,
  Holds<Refines<Client.JudgeOut, Schemas["JudgeOut"]>>,
  Holds<Refines<Client.Report, Schemas["ReportOut"]>>,
  Holds<Refines<Client.AnsweredQuestion, Schemas["AnsweredQuestionOut"]>>,
  Holds<Refines<Client.Review, Schemas["ReviewOut"]>>,
  // Interview history (#187). The saved report is an untyped dict on the backend.
  Holds<Refines<Client.InterviewHistoryItem, Schemas["InterviewHistoryItem"]>>,
  Holds<Refines<Client.TranscriptTurn, Schemas["TranscriptTurn"]>>,
  Holds<Refines<Admin.Assignment, Schemas["AssignmentIn"]>>,
];
