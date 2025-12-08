import { Redis } from 'ioredis';

const client = new Redis('redis://localhost:6379');
client.quit();
