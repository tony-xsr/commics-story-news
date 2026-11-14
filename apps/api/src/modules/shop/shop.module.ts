import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { WalletModule } from '../wallet/wallet.module';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';

/** Sticker packs (catalog, purchases, ownership). Admin side: shop-admin. */
@Module({
  imports: [WalletModule, PremiumModule],
  controllers: [ShopController],
  providers: [ShopService],
  exports: [ShopService],
})
export class ShopModule {}
