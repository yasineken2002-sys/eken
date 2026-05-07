import { Global, Module } from '@nestjs/common'
import { RedisService } from './redis.service'
import { LockService } from './lock.service'

@Global()
@Module({
  providers: [RedisService, LockService],
  exports: [RedisService, LockService],
})
export class RedisModule {}
