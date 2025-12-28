import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { ModerationService } from './moderation.service';

@Module({
  providers: [MessagesService, ModerationService],
  exports: [MessagesService, ModerationService],
})
export class ChatModule {}