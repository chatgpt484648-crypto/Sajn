import express from 'express';
import { configureApiRoutes } from '../server/app.ts';

const app = express();
configureApiRoutes(app);

export default app;
