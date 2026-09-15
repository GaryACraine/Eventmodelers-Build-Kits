import swaggerJsdoc from 'swagger-jsdoc';

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Context API',
            version: '1.0.0',
            description: 'Event-driven API for shift, clerk, and task management',
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Development server',
            },
            {
                url: process.env.API_URL || 'http://localhost:3000',
                description: 'Production server',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
    },
    // Edge functions carry their own @openapi blocks (see the build-webhook skill),
    // so a webhook shows up in the same document as the express routes.
    apis: ['./src/slices/**/routes.ts', './supabase/functions/**/index.ts'],
};

export const specs = swaggerJsdoc(options);
