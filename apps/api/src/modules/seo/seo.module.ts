import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { SeoAdminController, SeoController } from './seo.controller';
import { SeoService } from './seo.service';

/** Web SEO: settings, redirects, sitemap feed, audit (docs/features/038). */
@Module({ imports: [AdminModule], controllers: [SeoController, SeoAdminController], providers: [SeoService] })
export class SeoModule {}
