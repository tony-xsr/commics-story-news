import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { FeedbackAssignRequest, FeedbackReplyRequest, SupportMacroInput } from '@storyzio/contracts';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AdminRoute, CurrentAdmin, type AdminContext } from '../admin/permissions';
import { SupportService } from './support.service';

const uuid = () => new ParseUUIDPipe();

@Controller('v1/admin')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('feedback/:id')
  @AdminRoute('users.read')
  ticket(@CurrentAdmin() admin: AdminContext, @Param('id', uuid()) id: string) {
    return this.support.detail(admin, id);
  }

  @Post('feedback/:id/replies')
  @AdminRoute('users.read')
  reply(@CurrentAdmin() admin: AdminContext, @Param('id', uuid()) id: string, @Body(new ZodPipe(FeedbackReplyRequest)) body: FeedbackReplyRequest) {
    return this.support.reply(admin, id, body);
  }

  @Post('feedback/:id/assign')
  @AdminRoute('users.read')
  @HttpCode(HttpStatus.OK)
  assign(@CurrentAdmin() admin: AdminContext, @Param('id', uuid()) id: string, @Body(new ZodPipe(FeedbackAssignRequest)) body: FeedbackAssignRequest) {
    return this.support.assign(admin, id, body.assign);
  }

  @Get('support/macros')
  @AdminRoute('users.read')
  macros() {
    return this.support.macros();
  }

  @Post('support/macros')
  @AdminRoute('users.moderate')
  createMacro(@CurrentAdmin() admin: AdminContext, @Body(new ZodPipe(SupportMacroInput)) body: SupportMacroInput) {
    return this.support.saveMacro(admin, body);
  }

  @Put('support/macros/:id')
  @AdminRoute('users.moderate')
  updateMacro(@CurrentAdmin() admin: AdminContext, @Param('id', uuid()) id: string, @Body(new ZodPipe(SupportMacroInput)) body: SupportMacroInput) {
    return this.support.saveMacro(admin, body, id);
  }

  @Delete('support/macros/:id')
  @AdminRoute('users.moderate')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMacro(@CurrentAdmin() admin: AdminContext, @Param('id', uuid()) id: string) {
    return this.support.deleteMacro(admin, id);
  }
}
