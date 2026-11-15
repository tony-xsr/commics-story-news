import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { HideHistoryRequest, LibraryQuery, SaveProgressRequest } from '@storyzio/contracts';
import { CurrentAuth, type AuthContext } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { LibraryService } from './library.service';
import { ProgressService } from './progress.service';

/** Personal library. Every route requires a token (guests included); data is always the caller's own. */
@Controller('v1/me')
export class LibraryMeController {
  constructor(
    private readonly library: LibraryService,
    private readonly progress: ProgressService,
  ) {}

  @Get('stories/:id/state')
  state(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.library.state(auth.userId, id);
  }

  /** Called by the reader (debounced ~15 s, and when leaving the chapter / backgrounding the app). */
  @Put('progress')
  saveProgress(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(SaveProgressRequest)) body: SaveProgressRequest) {
    return this.progress.save(auth.userId, body);
  }

  @Get('favorites')
  favorites(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(LibraryQuery)) q: LibraryQuery) {
    return this.library.favorites(auth.userId, q);
  }

  @Put('favorites/:storyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addFavorite(@CurrentAuth() auth: AuthContext, @Param('storyId', new ParseUUIDPipe()) storyId: string) {
    await this.library.addFavorite(auth.userId, storyId);
  }

  @Delete('favorites/:storyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFavorite(@CurrentAuth() auth: AuthContext, @Param('storyId', new ParseUUIDPipe()) storyId: string) {
    await this.library.removeFavorite(auth.userId, storyId);
  }

  @Get('history')
  history(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(LibraryQuery)) q: LibraryQuery) {
    return this.library.history(auth.userId, q);
  }

  /** POST (not DELETE with a body — some proxies drop DELETE bodies). */
  @Post('history/hide')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hideHistory(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(HideHistoryRequest)) body: HideHistoryRequest) {
    await this.library.hideHistory(auth.userId, 'all' in body ? 'all' : body.storyIds);
  }
}
