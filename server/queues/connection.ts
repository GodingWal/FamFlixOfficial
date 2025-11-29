import IORedis from "ioredis";
import { config } from "../config";

let _redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis | null {
  if (!config.FEATURE_STORY_MODE) {
    return null;
  }
  
  if (!_redisConnection) {
    const redisUrl = config.REDIS_URL ?? "redis://127.0.0.1:6379";
    _redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  
  return _redisConnection;
}

export const redisConnection = config.FEATURE_STORY_MODE 
  ? new IORedis(config.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null })
  : null;
