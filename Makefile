.PHONY: install ensure-dev-env ensure-backend-deps ensure-frontend-deps dev dev-backend dev-frontend build prod test lint clean stop

install:
	python3 -m venv .venv
	. .venv/bin/activate && pip install -e ".[dev]"
	cd frontend && npm install

ensure-backend-deps:
	@if [ ! -f .venv/bin/activate ]; then \
		echo "Creating Python virtual environment..."; \
		python3 -m venv .venv; \
	fi
	@. .venv/bin/activate && python -c "import fastapi, uvicorn" >/dev/null 2>&1 || \
		(echo "Installing backend dependencies..." && . .venv/bin/activate && pip install -e ".[dev]")

ensure-frontend-deps:
	@if [ ! -x frontend/node_modules/.bin/vite ] || [ ! -x frontend/node_modules/.bin/tsc ]; then \
		echo "Installing frontend dependencies..."; \
		cd frontend && npm install; \
	fi

ensure-dev-env: ensure-backend-deps ensure-frontend-deps

dev: ensure-dev-env
	@echo "Starting backend on :8650 and frontend on :5173..."
	@trap 'kill 0' EXIT; \
	(. .venv/bin/activate && uvicorn backend.main:app --host 0.0.0.0 --port 8650 --reload) & \
	(cd frontend && npm run dev) & \
	wait

dev-backend:
	. .venv/bin/activate && uvicorn backend.main:app --host 0.0.0.0 --port 8650 --reload

dev-frontend:
	cd frontend && npm run dev

build: ensure-frontend-deps
	cd frontend && npm run build

prod: ensure-backend-deps build
	@PORT=$$(.venv/bin/python -c 'from backend.config import get_settings; print(get_settings().port)'); \
	echo "Starting production server on :$$PORT (serving frontend dist + API)..."; \
	. .venv/bin/activate && uvicorn backend.main:app --host 0.0.0.0 --port $$PORT

test:
	. .venv/bin/activate && pytest backend/tests -v

lint:
	. .venv/bin/activate && ruff check backend/
	cd frontend && npx tsc --noEmit

clean:
	rm -rf frontend/dist frontend/node_modules/.vite
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true

stop:
	@panel_port=$$(.venv/bin/python -c 'from backend.config import get_settings; print(get_settings().port)' 2>/dev/null || echo 80); \
	echo "Stopping Hermes Panel processes on configured port $$panel_port, 8650 and 5173..."; \
	for port in $$panel_port 80 8650 5173; do \
		pids=$$(lsof -ti tcp:$$port 2>/dev/null || fuser -n tcp $$port 2>/dev/null || true); \
		if [ -n "$$pids" ]; then \
			echo "Stopping process(es) on :$$port -> $$pids"; \
			fuser -k -TERM -n tcp $$port >/dev/null 2>&1 || kill $$pids 2>/dev/null || true; \
			if fuser -n tcp $$port >/dev/null 2>&1; then \
				echo "Force killing remaining process(es) on :$$port"; \
				fuser -k -KILL -n tcp $$port >/dev/null 2>&1 || true; \
			fi; \
		else \
			echo "No process is listening on :$$port"; \
		fi; \
	done
