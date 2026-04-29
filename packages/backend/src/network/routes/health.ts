import { Router, Request, Response } from 'express';

const router: Router = Router();

router.get('/', (_req: Request, res: Response) => {
    res.json({
        status: 'running',
        tick: 'discrete-event-system',
        db: 'sqlite-connected',
        uptime: process.uptime()
    });
});

export default router;
