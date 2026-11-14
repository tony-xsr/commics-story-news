import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  SeoRedirectImport,
  SeoRedirectInput,
  SeoRedirectLookup,
  SeoRedirectQuery,
  SeoSettingsInput,
  SitemapChunkQuery,
} from '@storyzio/contracts';
import { Public } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { PublicCache } from '../../common/http/cache-control';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AdminRoute, CurrentAdmin, type AdminContext } from '../admin/permissions';
import { SeoService } from './seo.service';

/** Public SEO feeds for the web reader (same for everyone → CDN-cached). */
@Controller('v1/seo')
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @Get('settings')
  @Public()
  @PublicCache({ cdn: 300, swr: 3600 })
  settings() {
    return this.seo.settings();
  }

  /** Asked by the web only for paths that would 404. */
  @Get('redirect')
  @Public()
  @PublicCache({ cdn: 300, swr: 3600 })
  async redirect(@Query(new ZodPipe(SeoRedirectLookup)) q: { path: string }) {
    const hit = await this.seo.lookup(q.path);
    if (!hit) throw new AppError('NOT_FOUND', 'No redirect');
    return hit;
  }

  @Get('sitemap')
  @Public()
  @PublicCache({ cdn: 600, swr: 3600 })
  sitemapStats() {
    return this.seo.sitemapStats();
  }

  @Get('sitemap/stories')
  @Public()
  @PublicCache({ cdn: 1800, swr: 3600 })
  async sitemapChunk(@Query(new ZodPipe(SitemapChunkQuery)) q: { chunk: number }) {
    return { items: await this.seo.sitemapChunk(q.chunk) };
  }
}

/** Admin “SEO” page (content team). */
@Controller('v1/admin/seo')
export class SeoAdminController {
  constructor(private readonly seo: SeoService) {}

  @Get('settings')
  @AdminRoute('catalog.write')
  settings() {
    return this.seo.settings();
  }

  @Put('settings')
  @AdminRoute('catalog.write')
  saveSettings(@CurrentAdmin() admin: AdminContext, @Body(new ZodPipe(SeoSettingsInput)) body: SeoSettingsInput) {
    return this.seo.saveSettings(admin, body);
  }

  @Get('audit')
  @AdminRoute('catalog.write')
  audit() {
    return this.seo.report();
  }

  @Get('redirects')
  @AdminRoute('catalog.write')
  redirects(@Query(new ZodPipe(SeoRedirectQuery)) q: { q?: string; page: number }) {
    return this.seo.listRedirects(q.q, q.page);
  }

  @Post('redirects')
  @AdminRoute('catalog.write')
  @HttpCode(HttpStatus.OK)
  createRedirect(@CurrentAdmin() admin: AdminContext, @Body(new ZodPipe(SeoRedirectInput)) body: SeoRedirectInput) {
    return this.seo.saveRedirect(admin, body);
  }

  @Put('redirects/:id')
  @AdminRoute('catalog.write')
  updateRedirect(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(SeoRedirectInput)) body: SeoRedirectInput,
  ) {
    return this.seo.saveRedirect(admin, body, id);
  }

  @Delete('redirects/:id')
  @AdminRoute('catalog.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRedirect(@CurrentAdmin() admin: AdminContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.seo.deleteRedirect(admin, id);
  }

  @Post('redirects/import')
  @AdminRoute('catalog.write')
  @HttpCode(HttpStatus.OK)
  importRedirects(@CurrentAdmin() admin: AdminContext, @Body(new ZodPipe(SeoRedirectImport)) body: SeoRedirectImport) {
    return this.seo.importRedirects(admin, body);
  }
}
