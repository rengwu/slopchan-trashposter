import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./test',use:{baseURL:'http://127.0.0.1:5178',viewport:{width:1440,height:1000}},webServer:{command:'npm run dev -- --port 5178',url:'http://127.0.0.1:5178',reuseExistingServer:false}});
