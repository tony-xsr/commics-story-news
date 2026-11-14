import { Module } from '@nestjs/common';
import { ContentGuardModule } from '../content-guard/content-guard.module';
import { IntegrityModule } from '../integrity/integrity.module';
import { PremiumModule } from '../premium/premium.module';
import { AuthorsController, ChaptersController, StoriesController } from './stories.controller';
import { StoriesRepo } from './stories.repo';
import { PublishingService } from './publishing.service';
import { StoriesService } from './stories.service';
import { SimilarService } from './similar.service';
import { ViewsService } from './views.service';

/** Stories + their chapters (list, detail, content, views). */
@Module({
  imports: [PremiumModule, ContentGuardModule, IntegrityModule],
  controllers: [StoriesController, ChaptersController, AuthorsController],
  providers: [StoriesRepo, StoriesService, ViewsService, PublishingService, SimilarService],
  exports: [StoriesService, ViewsService, PublishingService, SimilarService],
})
export class StoriesModule {}
