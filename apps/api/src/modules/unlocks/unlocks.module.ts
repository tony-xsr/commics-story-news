import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { PremiumModule } from '../premium/premium.module';
import { StoriesModule } from '../stories/stories.module';
import { WalletModule } from '../wallet/wallet.module';
import { UnlocksMeController } from './unlocks.me.controller';
import { UnlocksRepo } from './unlocks.repo';
import { UnlocksService } from './unlocks.service';

/** Chapter purchases with coins. The only writer of chapter_unlocks. */
@Module({
  imports: [StoriesModule, WalletModule, PremiumModule, PricingModule],
  controllers: [UnlocksMeController],
  providers: [UnlocksRepo, UnlocksService],
  exports: [UnlocksService],
})
export class UnlocksModule {}
