import { Injectable } from '@nestjs/common';
import type { AdminFeedbackDetail, FeedbackReplyRequest, SupportMacro, SupportMacroInput } from '@storyzio/contracts';
import { asc, desc, eq } from 'drizzle-orm';
import { AppError } from '../../common/errors/app-error';
import { feedback, feedbackReplies, supportMacros, users } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';
import { maskEmail } from '../admin/admin-users.service';
import { AuditService } from '../admin/audit.service';
import { can, type AdminContext } from '../admin/permissions';
import { InboxService } from '../inbox/inbox.service';

/** Title of the support reply in the user's inbox, in the account's language. */
const REPLY_TITLE: Record<string, string> = {
  en: 'Reply from StoryZio support',
  vi: 'Phản hồi từ bộ phận hỗ trợ StoryZio',
  ja: 'StoryZioサポートからの返信',
  ko: 'StoryZio 고객지원 답변',
  zh: 'StoryZio 客服回复',
  es: 'Respuesta del soporte de StoryZio',
  fr: 'Réponse du support StoryZio',
};

/**
 * Support desk (admin E1, E2): feedback from the app becomes a ticket — assign, reply (delivered to the user's
 * inbox in their language), resolve — plus canned replies per language. Every write is audited.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly inbox: InboxService,
  ) {}

  async detail(admin: AdminContext, id: string): Promise<AdminFeedbackDetail> {
    const [row] = await this.db.write
      .select({ f: feedback, u: { id: users.id, displayName: users.displayName, email: users.email, locale: users.locale, status: users.status } })
      .from(feedback)
      .innerJoin(users, eq(users.id, feedback.userId))
      .where(eq(feedback.id, id));
    if (!row) throw new AppError('NOT_FOUND', 'Ticket not found');
    const replies = await this.db.write
      .select()
      .from(feedbackReplies)
      .where(eq(feedbackReplies.feedbackId, id))
      .orderBy(asc(feedbackReplies.createdAt));
    const { f, u } = row;
    return {
      id: f.id,
      user: { ...u, email: can(admin, 'users.pii') ? u.email : maskEmail(u.email) },
      message: f.message,
      platform: f.platform,
      appVersion: f.appVersion,
      status: f.status,
      createdAt: f.createdAt.toISOString(),
      assigneeEmail: f.assigneeEmail,
      lastReplyAt: f.lastReplyAt?.toISOString() ?? null,
      replies: replies.map((r) => ({ id: r.id, adminEmail: r.adminEmail, body: r.body, createdAt: r.createdAt.toISOString() })),
    };
  }

  /** Saves the reply, sends it to the user's inbox, takes the ticket (in progress / resolved) — one transaction. */
  async reply(admin: AdminContext, id: string, req: FeedbackReplyRequest) {
    const [row] = await this.db.write
      .select({ f: feedback, locale: users.locale })
      .from(feedback)
      .innerJoin(users, eq(users.id, feedback.userId))
      .where(eq(feedback.id, id));
    if (!row) throw new AppError('NOT_FOUND', 'Ticket not found');
    const now = new Date();
    const status = req.resolve ? 'resolved' : 'in_progress';
    await this.db.write.transaction(async (tx) => {
      await tx.insert(feedbackReplies).values({ feedbackId: id, adminId: admin.adminId, adminEmail: admin.email, body: req.body });
      await tx
        .update(feedback)
        .set({
          status,
          lastReplyAt: now,
          resolvedAt: req.resolve ? now : null,
          // Replying takes an unassigned ticket.
          ...(row.f.assigneeId ? {} : { assigneeId: admin.adminId, assigneeEmail: admin.email }),
        })
        .where(eq(feedback.id, id));
      await this.inbox.notify(
        row.f.userId,
        { tab: 'update', title: REPLY_TITLE[row.locale] ?? REPLY_TITLE.en!, body: req.body, icon: 'support' },
        tx,
      );
      await this.audit.record(admin, { action: 'feedback.reply', entity: 'feedback', entityId: id, after: { body: req.body, status } }, tx);
    });
    return { status };
  }

  async assign(admin: AdminContext, id: string, to: 'me' | 'none') {
    const value = to === 'me' ? { assigneeId: admin.adminId, assigneeEmail: admin.email } : { assigneeId: null, assigneeEmail: null };
    await this.db.write.transaction(async (tx) => {
      const [row] = await tx.update(feedback).set(value).where(eq(feedback.id, id)).returning({ id: feedback.id });
      if (!row) throw new AppError('NOT_FOUND', 'Ticket not found');
      await this.audit.record(admin, { action: 'feedback.assign', entity: 'feedback', entityId: id, after: { assignee: value.assigneeEmail } }, tx);
    });
    return { assigneeEmail: value.assigneeEmail };
  }

  // ---- E2 canned replies ----

  async macros(): Promise<SupportMacro[]> {
    const rows = await this.db.read.select().from(supportMacros).orderBy(desc(supportMacros.updatedAt));
    return rows.map((m) => ({ id: m.id, title: m.title, body: m.body as SupportMacro['body'], updatedAt: m.updatedAt.toISOString() }));
  }

  async saveMacro(admin: AdminContext, input: SupportMacroInput, id?: string): Promise<{ id: string }> {
    return this.db.write.transaction(async (tx) => {
      const [row] = id
        ? await tx.update(supportMacros).set(input).where(eq(supportMacros.id, id)).returning({ id: supportMacros.id })
        : await tx.insert(supportMacros).values(input).returning({ id: supportMacros.id });
      if (!row) throw new AppError('NOT_FOUND', 'Macro not found');
      await this.audit.record(admin, { action: 'support_macro.save', entity: 'support_macro', entityId: row.id, after: input }, tx);
      return row;
    });
  }

  async deleteMacro(admin: AdminContext, id: string): Promise<void> {
    await this.db.write.transaction(async (tx) => {
      const [row] = await tx.delete(supportMacros).where(eq(supportMacros.id, id)).returning();
      if (!row) throw new AppError('NOT_FOUND', 'Macro not found');
      await this.audit.record(admin, { action: 'support_macro.delete', entity: 'support_macro', entityId: id, before: { title: row.title } }, tx);
    });
  }
}
