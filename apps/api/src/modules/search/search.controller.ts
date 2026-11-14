import { Controller, Get, Query } from '@nestjs/common';
import { SearchQuery, SuggestQuery } from '@storyzio/contracts';
import { Public } from '../../common/auth/auth.decorators';
import { PublicCache } from '../../common/http/cache-control';
import { ZodPipe } from '../../common/http/zod.pipe';
import { SearchService } from './search.service';

@Public()
@Controller('v1/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @PublicCache({ cdn: 60, swr: 300 })
  find(@Query(new ZodPipe(SearchQuery)) q: SearchQuery) {
    return this.search.search(q);
  }

  @Get('suggest')
  @PublicCache({ cdn: 60, swr: 300 })
  suggest(@Query(new ZodPipe(SuggestQuery)) q: SuggestQuery) {
    return this.search.suggest(q);
  }
}
