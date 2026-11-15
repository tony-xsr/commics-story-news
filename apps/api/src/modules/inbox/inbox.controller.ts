import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put, Query } from '@nestjs/common';
import { InboxQuery, InboxReadRequest, NotificationSettingsPatch, PushTokenRequest } from '@storyzio/contracts';
import { CurrentAuth, type AuthContext } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { InboxService } from './inbox.service';

/** Personal inbox, push tokens, notification settings — always the caller's own. */
@Controller('v1/me')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('inbox')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(InboxQuery)) q: InboxQuery) {
    return this.inbox.list(auth, q);
  }

  @Get('inbox/unread-count')
  unread(@CurrentAuth() auth: AuthContext) {
    return this.inbox.unreadCount(auth);
  }

  @Post('inbox/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(InboxReadRequest)) body: InboxReadRequest) {
    await this.inbox.markRead(auth.userId, body);
  }

  @Put('push-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(PushTokenRequest)) body: PushTokenRequest) {
    await this.inbox.registerToken(auth.userId, body);
  }

  /** On sign-out: the device stops receiving this account's pushes. */
  @Delete('push-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(PushTokenRequest)) body: PushTokenRequest) {
    await this.inbox.removeToken(auth.userId, body.token);
  }

  @Get('notification-settings')
  settings(@CurrentAuth() auth: AuthContext) {
    return this.inbox.settings(auth.userId);
  }

  @Patch('notification-settings')
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(NotificationSettingsPatch)) body: NotificationSettingsPatch,
  ) {
    return this.inbox.updateSettings(auth.userId, body);
  }
}
