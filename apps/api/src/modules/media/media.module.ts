import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

/** Admin media uploads (covers, comic pages) → object storage. Storage itself is the global StorageModule. */
@Module({ imports: [AdminModule], controllers: [UploadsController], providers: [UploadsService] })
export class MediaModule {}
