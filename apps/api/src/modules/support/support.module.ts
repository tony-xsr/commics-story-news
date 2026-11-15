import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { InboxModule } from '../inbox/inbox.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/** Admin-side support desk (tickets from in-app feedback, canned replies). Never imported by the worker. */
@Module({ imports: [AdminModule, InboxModule], controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
