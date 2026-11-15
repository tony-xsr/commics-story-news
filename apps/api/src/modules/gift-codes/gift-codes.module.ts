import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { GiftCodesController } from './gift-codes.controller';
import { GiftCodesService } from './gift-codes.service';

/** Redeeming gift codes (coins / points). Admin side: gift-codes-admin. */
@Module({
  imports: [WalletModule],
  controllers: [GiftCodesController],
  providers: [GiftCodesService],
})
export class GiftCodesModule {}
