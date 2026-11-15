import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { WalletModule } from '../wallet/wallet.module';
import { EventPushService } from './event-push.service';
import { PushDispatchService } from './push-dispatch.service';
import { BroadcastPushService } from './broadcast-push.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/** Inbox (personal ∪ broadcasts), push tokens, broadcast push fan-out (run by the worker). */
@Module({
  imports: [PremiumModule, WalletModule],
  controllers: [InboxController],
  providers: [InboxService, BroadcastPushService, PushDispatchService, EventPushService],
  exports: [InboxService, BroadcastPushService, EventPushService, PushDispatchService],
})
export class InboxModule {}
