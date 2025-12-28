import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { MessagesService } from '../chat/messages.service';
import { LoggingService } from '../../common/utils/logging.service';

@Module({
  imports: [AuthModule, ChatModule],
  providers: [
    BotService,
    MessagesService,
    LoggingService,
  ],
  exports: [BotService],
})
export class BotModule {}