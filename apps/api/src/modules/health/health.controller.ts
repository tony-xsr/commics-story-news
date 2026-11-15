import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/auth/auth.decorators';
import { DbService } from '../../infra/db/db.service';
import { RedisService } from '../../infra/redis/redis.service';

/** `/healthz`: process is alive (liveness). `/readyz`: dependencies reachable (readiness, load balancer). */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply) {
    const [db, redis] = await Promise.all([this.db.ping(), this.redis.ping()]);
    const ready = db && redis;
    reply.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { db, redis } };
  }
}
