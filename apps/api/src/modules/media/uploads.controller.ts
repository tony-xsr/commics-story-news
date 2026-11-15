import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { UploadRequest } from '@storyzio/contracts';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AdminRoute, CurrentAdmin, type AdminContext } from '../admin/permissions';
import { UploadsService } from './uploads.service';

@Controller('v1/admin/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @AdminRoute('stories.write')
  create(@CurrentAdmin() admin: AdminContext, @Body(new ZodPipe(UploadRequest)) body: UploadRequest) {
    return this.uploads.create(admin, body);
  }

  @Post(':id/complete')
  @AdminRoute('stories.write')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentAdmin() admin: AdminContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.uploads.complete(admin, id);
  }
}
