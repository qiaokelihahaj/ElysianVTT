import express from 'express';
import { healthRouter } from './network/routes/index.js';

export function createApp(): express.Express {
    const app = express();

    app.use(express.json());

    app.use('/health', healthRouter);

    return app;
}
