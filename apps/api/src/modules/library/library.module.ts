import { Module } from '@nestjs/common';
import { StoriesModule } from '../stories/stories.module';
import { LibraryMeController } from './library.me.controller';
import { LibraryRepo } from './library.repo';
import { LibraryService } from './library.service';
import { ProgressService } from './progress.service';

/** Favorites, reading progress / history, per-user story state. */
@Module({
  imports: [StoriesModule],
  controllers: [LibraryMeController],
  providers: [LibraryRepo, LibraryService, ProgressService],
  exports: [LibraryService, ProgressService],
})
export class LibraryModule {}
