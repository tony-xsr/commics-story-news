import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IntegrityProofRequest } from '@storyzio/contracts';
import { CurrentAuth, type AuthContext } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { IntegrityService } from './integrity.service';

@Controller('v1/me/integrity')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  /** Single-use challenge (5 min) for App Attest / Play Integrity. */
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  challenge(@CurrentAuth() auth: AuthContext) {
    return this.integrity.challenge(auth);
  }

  /** Proof of a genuine app on a real device → this session's paid-read pass (24 h). */
  @Post()
  @HttpCode(HttpStatus.OK)
  prove(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(IntegrityProofRequest)) body: IntegrityProofRequest) {
    return this.integrity.prove(auth, body);
  }
}
