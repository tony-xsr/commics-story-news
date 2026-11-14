import { Module } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { DbService } from '../../infra/db/db.service';
import { StoriesModule } from '../stories/stories.module';
import { MeiliEngine } from './meili.engine';
import { SEARCH_ENGINE } from './search.engine';
import { PgSearchEngine, SearchRepo } from './search.repo';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** Story search (Meilisearch; Postgres match when not configured). Index kept in sync by the worker. */
@Module({
  imports: [StoriesModule],
  controllers: [SearchController],
  providers: [
    SearchRepo,
    SearchService,
    {
      provide: SEARCH_ENGINE,
      inject: [ENV, DbService],
      useFactory: (env: Env, db: DbService) =>
        env.search.meiliUrl
          ? new MeiliEngine(env.search.meiliUrl, env.search.meiliKey, env.search.index)
          : new PgSearchEngine(db),
    },
  ],
  exports: [SearchService],
})
export class SearchModule {}
