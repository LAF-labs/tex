-- 예상 밖 화면 판정·브라우저 에이전트(page_judge·browser_agent) 실행당 호출 수(GATEWAY.agentPerRun)
ALTER TABLE run_scopes ADD COLUMN agent_calls INTEGER NOT NULL DEFAULT 0;
