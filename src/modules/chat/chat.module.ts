import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { MessagesService } from './messages.service';
import { OnlineUsersService } from './online-users.service';
import { ModerationService } from './moderation.service';
import { UtilsService } from '../../common/utils/utils.service';
import { MemoryService } from '../../common/utils/memory.service';
import { LoggingService } from '../../common/utils/logging.service';

@Module({
  providers: [ChatService, MessagesService, OnlineUsersService, ModerationService, UtilsService, MemoryService, LoggingService],
  exports: [ChatService, MessagesService, OnlineUsersService, ModerationService],
})
export class ChatModule {}