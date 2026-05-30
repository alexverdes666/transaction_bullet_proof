/**
 * Cached Mongoose connection. Next.js (and serverless) re-evaluate modules
 * frequently, so we memoise the connection on `globalThis` to avoid opening a
 * new pool on every request / hot reload.
 */
import 'server-only';
import mongoose from 'mongoose';
import { env } from './env';

interface Cache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const globalForMongoose = globalThis as unknown as { _mongoose?: Cache };
const cache: Cache = globalForMongoose._mongoose ?? { conn: null, promise: null };
globalForMongoose._mongoose = cache;

export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    cache.promise = mongoose
      .connect(env.mongoUri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
      })
      .catch((e) => {
        // Never cache a REJECTED promise: otherwise one transient Atlas blip
        // wedges every later request until a redeploy. Clear it so the next
        // call retries the connection.
        cache.promise = null;
        throw e;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}
