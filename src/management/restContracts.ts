import { z } from 'zod';

const id = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+$/);
const name = z.string().trim().min(1).max(256);
const description = z.string().max(4_096);
const connection = id;
const version = z.string().regex(/^[a-f0-9]{64}$/);
const page = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2_048).optional(),
};
const app = { connection, appId: id };
const appWrite = { ...app, expectedSourceVersion: version };
const space = { connection, spaceId: id };
const spaceWrite = { ...space, expectedSourceVersion: version };
const file = { connection, fileId: id };
const fileWrite = { ...file, expectedSourceVersion: version };
const member = { ...space, assignmentId: id };
const share = { ...space, shareId: id };
const schedule = { connection, taskId: id };
const role = z.enum([
  'consumer',
  'contributor',
  'dataconsumer',
  'datapreview',
  'facilitator',
  'operator',
  'producer',
  'publisher',
  'basicconsumer',
  'codeveloper',
]);
const roles = z
  .array(role)
  .min(1)
  .max(10)
  .refine((values) => new Set(values).size === values.length);
const shareRoles = z
  .array(z.enum(['consumer', 'contributor', 'basicconsumer']))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);
const spaceName = name.regex(/^[^"*?<>/|\\:]+$/);
const fileName = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes('\\') &&
      ![...value].some((character) => character.charCodeAt(0) < 32) &&
      value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
  );
const upload = {
  contentBase64: z.string().max(70_000_000).optional(),
  contentSha256: version.optional(),
  tempContentFileId: id.optional(),
};
const validUpload = (value: {
  contentBase64?: string;
  contentSha256?: string;
  tempContentFileId?: string;
}) =>
  value.tempContentFileId !== undefined
    ? value.contentBase64 === undefined && value.contentSha256 === undefined
    : value.contentBase64 !== undefined && value.contentSha256 !== undefined;
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const scheduleDefinition = z
  .object({
    recurrence: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^RRULE:[^\r\n]+$/)
      .optional(),
    cron: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n]+$/)
      .optional(),
    interval: z
      .string()
      .min(1)
      .max(256)
      .regex(/^R[^\r\n]*\//)
      .optional(),
    timezone,
    startDateTime: z
      .string()
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value)))
      .optional(),
    endDateTime: z
      .string()
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value)))
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.recurrence, value.cron, value.interval].filter((item) => item !== undefined).length ===
      1,
    'Specify exactly one recurrence, cron, or interval.',
  );

/** Exact action boundary; no raw endpoint, free-form SDK body, or unbounded page traversal. */
export const REST_ACTION_SCHEMAS = {
  'app.list': z
    .object({ connection, ...page, name: name.optional(), spaceId: id.nullable().optional() })
    .strict(),
  'app.create': z
    .object({
      connection,
      name,
      description: description.optional(),
      spaceId: id.nullable(),
      locale: z.string().min(2).max(32).optional(),
    })
    .strict(),
  'app.get': z.object(app).strict(),
  'app.update': z
    .object({ ...appWrite, name: name.optional(), description: description.optional() })
    .strict()
    .refine((value) => value.name !== undefined || value.description !== undefined),
  'app.duplicate': z
    .object({ ...appWrite, name, spaceId: id.nullable(), description: description.optional() })
    .strict(),
  'app.move': z.object({ ...appWrite, spaceId: id.nullable() }).strict(),
  'app.delete': z.object(appWrite).strict(),
  'app.publish': z
    .object({
      ...appWrite,
      spaceId: id,
      name: name.optional(),
      description: description.optional(),
      data: z.enum(['source', 'target']).default('source'),
    })
    .strict(),
  'app.export': z.object({ ...app, noData: z.boolean().default(false) }).strict(),
  'space.list': z
    .object({
      connection,
      ...page,
      name: name.optional(),
      type: z.enum(['shared', 'managed', 'data']).optional(),
    })
    .strict(),
  'space.get': z.object(space).strict(),
  'space.create': z
    .object({
      connection,
      name: spaceName,
      description: description.optional(),
      type: z.enum(['shared', 'managed', 'data']),
    })
    .strict(),
  'space.update': z
    .object({ ...spaceWrite, name: spaceName.optional(), description: description.optional() })
    .strict()
    .refine((value) => value.name !== undefined || value.description !== undefined),
  'space.delete': z.object(spaceWrite).strict(),
  'space.member.list': z.object({ ...space, ...page }).strict(),
  'space.member.get': z.object(member).strict(),
  'space.member.create': z
    .object({ ...space, assigneeId: id, type: z.enum(['user', 'group', 'bot']), roles })
    .strict(),
  'space.member.update': z.object({ ...member, expectedSourceVersion: version, roles }).strict(),
  'space.member.delete': z.object({ ...member, expectedSourceVersion: version }).strict(),
  'space.share.list': z.object({ ...space, ...page, appId: id.optional() }).strict(),
  'space.share.get': z.object(share).strict(),
  'space.share.create': z
    .object({
      ...space,
      appId: id,
      assigneeId: id,
      type: z.enum(['user', 'group', 'link']),
      roles: shareRoles,
    })
    .strict(),
  'space.share.update': z
    .object({
      ...share,
      expectedSourceVersion: version,
      roles: shareRoles.optional(),
      disabled: z.boolean().optional(),
    })
    .strict()
    .refine((value) => value.roles !== undefined || value.disabled !== undefined),
  'space.share.delete': z.object({ ...share, expectedSourceVersion: version }).strict(),
  'datafile.list': z
    .object({
      connection,
      spaceId: id.nullable(),
      ...page,
      appId: id.optional(),
      name: fileName.optional(),
      folderId: id.optional(),
    })
    .strict(),
  'datafile.get': z.object(file).strict(),
  'datafile.upload': z
    .object({
      connection,
      name: fileName,
      spaceId: id.nullable(),
      appId: id.optional(),
      folderId: id.optional(),
      ...upload,
    })
    .strict()
    .refine(validUpload, 'Supply checked content or one staged Qlik temporary content ID.'),
  'datafile.replace': z
    .object({ ...fileWrite, name: fileName.optional(), ...upload })
    .strict()
    .refine(validUpload, 'Supply checked content or one staged Qlik temporary content ID.'),
  'datafile.delete': z.object(fileWrite).strict(),
  'datafile.quotas': z.object({ connection }).strict(),
  'reload.list': z.object({ ...app, ...page }).strict(),
  'reload.create': z.object({ ...app, partial: z.boolean().default(false) }).strict(),
  'reload.get': z.object({ connection, reloadId: id }).strict(),
  'reload.cancel': z.object({ connection, reloadId: id, expectedSourceVersion: version }).strict(),
  'reload.log': z.object({ ...app, reloadId: id }).strict(),
  'schedule.list': z.object({ ...app, ...page }).strict(),
  'schedule.get': z.object(schedule).strict(),
  'schedule.create': z
    .object({
      ...app,
      name,
      enabled: z.boolean().default(true),
      partial: z.boolean().default(false),
      schedule: scheduleDefinition,
    })
    .strict(),
  'schedule.update': z
    .object({
      ...schedule,
      expectedSourceVersion: version,
      name: name.optional(),
      enabled: z.boolean().optional(),
      schedule: scheduleDefinition.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.name !== undefined || value.enabled !== undefined || value.schedule !== undefined,
    ),
  'schedule.delete': z.object({ ...schedule, expectedSourceVersion: version }).strict(),
} satisfies Record<string, z.ZodType<Record<string, unknown>>>;

export type RestManagementAction = keyof typeof REST_ACTION_SCHEMAS;
export const REST_READ_ACTIONS: ReadonlySet<string> = new Set([
  'app.list',
  'app.get',
  'space.list',
  'space.get',
  'space.member.list',
  'space.member.get',
  'space.share.list',
  'space.share.get',
  'datafile.list',
  'datafile.get',
  'datafile.quotas',
  'reload.list',
  'reload.get',
  'reload.log',
  'schedule.list',
  'schedule.get',
]);

export function isRestManagementAction(action: string): action is RestManagementAction {
  return Object.hasOwn(REST_ACTION_SCHEMAS, action);
}
