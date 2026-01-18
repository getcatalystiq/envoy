#!/bin/bash
set -euo pipefail

# Envoy Local Development Setup Script
# Usage: ./scripts/setup-local.sh [--skip-deps] [--tunnel|--local-db] [--migrate] [--terminal] [--no-scheduler] [--no-email-scheduler]
#
# Options:
#   --skip-deps           Skip dependency installation (faster restart)
#   --tunnel              Use remote dev database via SSM tunnel (default)
#   --local-db            Use local PostgreSQL database
#   --migrate             Force run migrations (local-db only)
#   --bg                  Run as background processes (default)
#   --terminal            Open Terminal/Warp windows instead of background
#   --warp                Use Warp terminal (with --terminal)
#   --no-scheduler        Skip starting the sequence scheduler
#   --no-email-scheduler  Skip starting the email scheduler

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
SKIP_DEPS=false
USE_TUNNEL=true
FORCE_MIGRATE=false
USE_WARP=false
USE_BG=true
RUN_SCHEDULER=true
RUN_EMAIL_SCHEDULER=true

# Parse arguments
for arg in "$@"; do
    case $arg in
        --skip-deps)
            SKIP_DEPS=true
            ;;
        --tunnel)
            USE_TUNNEL=true
            ;;
        --local-db)
            USE_TUNNEL=false
            ;;
        --migrate)
            FORCE_MIGRATE=true
            ;;
        --warp)
            USE_WARP=true
            ;;
        --bg)
            USE_BG=true
            ;;
        --terminal|--no-bg)
            USE_BG=false
            ;;
        --no-scheduler)
            RUN_SCHEDULER=false
            ;;
        --no-email-scheduler)
            RUN_EMAIL_SCHEDULER=false
            ;;
        --help|-h)
            echo "Usage: ./scripts/setup-local.sh [--skip-deps] [--tunnel|--local-db] [--migrate] [--terminal] [--no-scheduler] [--no-email-scheduler]"
            echo ""
            echo "Options:"
            echo "  --skip-deps           Skip dependency installation (faster restart)"
            echo "  --tunnel              Use remote dev database via SSM tunnel (default)"
            echo "  --local-db            Use local PostgreSQL database"
            echo "  --migrate             Force run migrations (local-db only)"
            echo "  --bg                  Run as background processes (default)"
            echo "  --terminal            Open Terminal/Warp windows instead of background"
            echo "  --warp                Use Warp terminal (with --terminal)"
            echo "  --no-scheduler        Skip starting the sequence scheduler"
            echo "  --no-email-scheduler  Skip starting the email scheduler"
            exit 0
            ;;
    esac
done

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Envoy Local Development Setup                     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

cd "$PROJECT_DIR"

# =============================================================================
# Kill existing processes on required ports
# =============================================================================
echo -e "${YELLOW}[0/6] Cleaning up existing processes...${NC}"

# Ports used by our services
PORTS=(3000 8000 5433)

kill_port() {
    local port=$1
    local pids=$(lsof -ti :"$port" 2>/dev/null)
    if [[ -n "$pids" ]]; then
        echo "  Killing processes on port $port..."
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

for port in "${PORTS[@]}"; do
    kill_port "$port"
done

# Also kill any existing tmp scripts that might be running
pkill -f "\.tmp-db-tunnel\.sh" 2>/dev/null || true
pkill -f "\.tmp-backend\.sh" 2>/dev/null || true
pkill -f "\.tmp-frontend\.sh" 2>/dev/null || true
pkill -f "\.tmp-scheduler\.sh" 2>/dev/null || true
pkill -f "\.tmp-email-scheduler\.sh" 2>/dev/null || true

# Clean up any leftover tmp files
rm -f "$PROJECT_DIR/.tmp-db-tunnel.sh" "$PROJECT_DIR/.tmp-backend.sh" "$PROJECT_DIR/.tmp-frontend.sh" "$PROJECT_DIR/.tmp-scheduler.sh" "$PROJECT_DIR/.tmp-email-scheduler.sh" 2>/dev/null || true

echo -e "${GREEN}✓ Ports 3000, 8000, 5433 cleared${NC}"
echo ""

# =============================================================================
# Check Prerequisites
# =============================================================================
echo -e "${YELLOW}[1/7] Checking prerequisites...${NC}"

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}✗ $1 is not installed${NC}"
        echo "  Install with: $2"
        return 1
    else
        echo -e "${GREEN}✓ $1 found${NC}"
        return 0
    fi
}

MISSING_DEPS=false

check_command "python3" "brew install python@3.12" || MISSING_DEPS=true
check_command "node" "brew install node" || MISSING_DEPS=true
check_command "npm" "brew install node" || MISSING_DEPS=true

if $USE_TUNNEL; then
    check_command "aws" "brew install awscli" || MISSING_DEPS=true
else
    check_command "psql" "brew install postgresql@16" || MISSING_DEPS=true
fi

if $MISSING_DEPS; then
    echo ""
    echo -e "${RED}Please install missing dependencies and try again.${NC}"
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if [[ $(echo "$PYTHON_VERSION < 3.12" | bc -l) -eq 1 ]]; then
    echo -e "${YELLOW}⚠ Python $PYTHON_VERSION detected. Python 3.12+ recommended.${NC}"
fi

echo ""

# =============================================================================
# Set up Python Virtual Environment
# =============================================================================
echo -e "${YELLOW}[2/7] Setting up Python virtual environment...${NC}"

if [[ ! -d ".venv" ]]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    echo -e "${GREEN}✓ Virtual environment created${NC}"
else
    echo -e "${GREEN}✓ Virtual environment already exists${NC}"
fi

# Activate virtual environment
source .venv/bin/activate
echo -e "${GREEN}✓ Virtual environment activated${NC}"
echo ""

# =============================================================================
# Install Dependencies
# =============================================================================
echo -e "${YELLOW}[3/7] Installing dependencies...${NC}"

if $SKIP_DEPS; then
    echo -e "${BLUE}Skipping dependency installation (--skip-deps)${NC}"
else
    echo "Installing Python dependencies..."
    pip install --quiet --upgrade pip
    pip install --quiet -r layers/shared/requirements.txt
    pip install --quiet -r functions/api/requirements.txt
    pip install --quiet uvicorn  # For local dev server
    echo -e "${GREEN}✓ Python dependencies installed${NC}"

    echo "Installing Node.js dependencies..."
    cd admin-ui
    npm install --silent
    cd "$PROJECT_DIR"
    echo -e "${GREEN}✓ Node.js dependencies installed${NC}"
fi
echo ""

# =============================================================================
# Database Setup
# =============================================================================
echo -e "${YELLOW}[4/7] Setting up database connection...${NC}"

LOCAL_DB_URL="postgresql://envoy_app:localdev@localhost:5432/envoy"

if $USE_TUNNEL; then
    echo "Will open SSM tunnel to remote dev database"

    # Check if AWS credentials are valid
    echo "Checking AWS credentials..."
    if ! aws sts get-caller-identity &>/dev/null; then
        echo -e "${YELLOW}AWS session expired or not logged in. Logging in...${NC}"
        aws sso login || {
            echo -e "${RED}AWS login failed. Please run 'aws sso login' manually.${NC}"
            exit 1
        }
    fi
    echo -e "${GREEN}✓ AWS credentials valid${NC}"
else
    echo "Using local PostgreSQL database"

    # Check if PostgreSQL is running
    if ! pg_isready -q 2>/dev/null; then
        echo "Starting PostgreSQL..."
        brew services start postgresql@16 2>/dev/null || true
        sleep 2
    fi

    # Check if database exists
    NEEDS_MIGRATION=false
    if ! psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw envoy; then
        echo "Creating database 'envoy'..."
        createdb envoy 2>/dev/null || true
        psql -c "CREATE USER envoy_app WITH PASSWORD 'localdev';" 2>/dev/null || true
        psql -c "GRANT ALL PRIVILEGES ON DATABASE envoy TO envoy_app;" 2>/dev/null || true
        psql -d envoy -c "GRANT ALL ON SCHEMA public TO envoy_app;" 2>/dev/null || true
        echo -e "${GREEN}✓ Database created${NC}"
        NEEDS_MIGRATION=true
    else
        echo -e "${GREEN}✓ Database 'envoy' exists${NC}"
        # Check if migrations table exists to determine if we need to migrate
        if ! psql "$LOCAL_DB_URL" -c "SELECT 1 FROM schema_migrations LIMIT 1" &>/dev/null; then
            NEEDS_MIGRATION=true
        fi
    fi
fi
echo ""

# =============================================================================
# Run Migrations (local DB only)
# =============================================================================
if ! $USE_TUNNEL; then
    echo -e "${YELLOW}[5/7] Running database migrations...${NC}"

    if $NEEDS_MIGRATION || $FORCE_MIGRATE; then
        echo "Applying migrations..."
        if DATABASE_URL="$LOCAL_DB_URL" ./scripts/run-migrations.sh; then
            echo -e "${GREEN}✓ Migrations applied${NC}"
        else
            echo -e "${YELLOW}⚠ Some migrations may have failed - check output above${NC}"
        fi
    else
        # Check for pending migrations
        LATEST_MIGRATION=$(ls migrations/*.sql 2>/dev/null | sort | tail -1 | xargs basename | cut -d'_' -f1)
        APPLIED_VERSION=$(psql "$LOCAL_DB_URL" -t -c "SELECT MAX(version) FROM schema_migrations" 2>/dev/null | tr -d ' ')

        if [[ "$LATEST_MIGRATION" != "$APPLIED_VERSION" ]]; then
            echo "New migrations detected, applying..."
            if DATABASE_URL="$LOCAL_DB_URL" ./scripts/run-migrations.sh; then
                echo -e "${GREEN}✓ Migrations applied${NC}"
            else
                echo -e "${YELLOW}⚠ Some migrations may have failed - check output above${NC}"
            fi
        else
            echo -e "${GREEN}✓ Database is up to date (version $APPLIED_VERSION)${NC}"
        fi
    fi
    echo ""
else
    echo -e "${YELLOW}[5/7] Skipping migrations (using remote dev database)${NC}"
    echo ""
fi

# =============================================================================
# Launch Services in Terminal Windows
# =============================================================================
echo -e "${YELLOW}[6/7] Launching services...${NC}"

# Create temporary scripts for each terminal window
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

if $USE_TUNNEL; then
    # Database tunnel script
    cat > "$PROJECT_DIR/.tmp-db-tunnel.sh" << TUNNEL_SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"
echo "═══════════════════════════════════════════════════════════"
echo "  DATABASE TUNNEL - Connecting to dev Aurora..."
echo "═══════════════════════════════════════════════════════════"
echo ""
./scripts/db-tunnel.sh dev 5433
TUNNEL_SCRIPT
    chmod +x "$PROJECT_DIR/.tmp-db-tunnel.sh"
fi

# Backend script
cat > "$PROJECT_DIR/.tmp-backend.sh" << BACKEND_SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"
source .venv/bin/activate
echo "═══════════════════════════════════════════════════════════"
echo "  BACKEND API - http://localhost:8000"
echo "  API Docs:    http://localhost:8000/docs"
echo "═══════════════════════════════════════════════════════════"
echo ""
sleep 2  # Wait for tunnel if using remote DB
./scripts/local-dev.sh
BACKEND_SCRIPT
chmod +x "$PROJECT_DIR/.tmp-backend.sh"

# Frontend script
cat > "$PROJECT_DIR/.tmp-frontend.sh" << FRONTEND_SCRIPT
#!/bin/bash
cd "$PROJECT_DIR/admin-ui"
echo "═══════════════════════════════════════════════════════════"
echo "  FRONTEND - http://localhost:3000"
echo "═══════════════════════════════════════════════════════════"
echo ""
sleep 3  # Wait for backend to start
npm run dev
FRONTEND_SCRIPT
chmod +x "$PROJECT_DIR/.tmp-frontend.sh"

# Sequence scheduler script (runs in a loop)
if $RUN_SCHEDULER; then
    cat > "$PROJECT_DIR/.tmp-scheduler.sh" << SCHEDULER_SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"
source .venv/bin/activate
echo "═══════════════════════════════════════════════════════════"
echo "  SEQUENCE SCHEDULER - Running every 30 seconds"
echo "═══════════════════════════════════════════════════════════"
echo ""
sleep 5  # Wait for backend and DB to be ready

export PYTHONPATH="$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/sequence_scheduler"
export AURORA_SECRET_ARN=envoy-dev-aurora-credentials
export AURORA_HOST=localhost
export AURORA_PORT=5433
export AURORA_DATABASE=envoy

while true; do
    echo ""
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Running sequence scheduler..."
    python -c "
import asyncio
import sys
sys.path.insert(0, '$PROJECT_DIR/layers/shared')
sys.path.insert(0, '$PROJECT_DIR/functions/sequence_scheduler')
from handler import main
try:
    result = asyncio.run(main())
    print(f\"  Processed {result.get('processed', 0)} enrollments\")
    for r in result.get('results', []):
        print(f\"    - {r.get('enrollment_id')}: {r.get('action')}\")
except Exception as e:
    print(f\"  Error: {e}\")
"
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Sleeping for 30 seconds..."
    sleep 30
done
SCHEDULER_SCRIPT
    chmod +x "$PROJECT_DIR/.tmp-scheduler.sh"
fi

# Email scheduler script (runs in a loop)
if $RUN_EMAIL_SCHEDULER; then
    cat > "$PROJECT_DIR/.tmp-email-scheduler.sh" << EMAIL_SCHEDULER_SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"
source .venv/bin/activate
echo "═══════════════════════════════════════════════════════════"
echo "  EMAIL SCHEDULER - Running every 60 seconds"
echo "═══════════════════════════════════════════════════════════"
echo ""
sleep 5  # Wait for backend and DB to be ready

export PYTHONPATH="$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/email_scheduler"
export AURORA_SECRET_ARN=envoy-dev-aurora-credentials
export AURORA_HOST=localhost
export AURORA_PORT=5433
export AURORA_DATABASE=envoy

while true; do
    echo ""
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Running email scheduler..."
    python -c "
import asyncio
import sys
sys.path.insert(0, '$PROJECT_DIR/layers/shared')
sys.path.insert(0, '$PROJECT_DIR/functions/email_scheduler')
from handler import main
try:
    result = asyncio.run(main())
    campaigns = result.get('campaigns', {})
    emails = result.get('emails', {})
    print(f\"  Campaigns processed: {campaigns.get('campaigns_processed', 0)}\")
    print(f\"  Emails sent: {emails.get('sent', 0)}, failed: {emails.get('failed', 0)}\")
except Exception as e:
    print(f\"  Error: {e}\")
"
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Sleeping for 60 seconds..."
    sleep 60
done
EMAIL_SCHEDULER_SCRIPT
    chmod +x "$PROJECT_DIR/.tmp-email-scheduler.sh"
fi

# Launch services
if $USE_BG; then
    # Background mode - output commands for Claude Code to run as background tasks
    echo -e "${GREEN}✓ Setup complete${NC}"
    echo ""
    echo -e "${YELLOW}IMPORTANT: Kill existing Claude Code background tasks first (DB Tunnel, Backend, Frontend)${NC}"
    echo -e "${YELLOW}before starting new ones to avoid duplicate processes.${NC}"
    echo ""
    echo "Run these commands as Claude Code background tasks:"
    echo ""
    if $USE_TUNNEL; then
        echo "# DB Tunnel"
        echo "$PROJECT_DIR/scripts/db-tunnel.sh dev 5433"
        echo ""
    fi
    echo "# Backend API"
    echo "source $PROJECT_DIR/.venv/bin/activate && PYTHONPATH=\"$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/api\" AURORA_SECRET_ARN=envoy-dev-aurora-credentials AURORA_HOST=localhost AURORA_PORT=5433 AURORA_DATABASE=envoy JWT_PUBLIC_KEY=\"\" JWT_ISSUER=\"http://localhost\" python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --app-dir \"$PROJECT_DIR/functions/api\""
    echo ""
    echo "# Frontend"
    echo "cd $PROJECT_DIR/admin-ui && npm run dev"
    echo ""
    if $RUN_SCHEDULER; then
        echo "# Sequence Scheduler"
        echo "$PROJECT_DIR/.tmp-scheduler.sh"
        echo ""
    fi
    if $RUN_EMAIL_SCHEDULER; then
        echo "# Email Scheduler"
        echo "$PROJECT_DIR/.tmp-email-scheduler.sh"
        echo ""
    fi

    # Output in a parseable format for automation
    echo "---CLAUDE_CODE_COMMANDS---"
    if $USE_TUNNEL; then
        echo "DB Tunnel|$PROJECT_DIR/scripts/db-tunnel.sh dev 5433"
    fi
    echo "Backend API|source $PROJECT_DIR/.venv/bin/activate && PYTHONPATH=\"$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/api\" AURORA_SECRET_ARN=envoy-dev-aurora-credentials AURORA_HOST=localhost AURORA_PORT=5433 AURORA_DATABASE=envoy JWT_PUBLIC_KEY=\"\" JWT_ISSUER=\"http://localhost\" python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --app-dir \"$PROJECT_DIR/functions/api\""
    echo "Frontend|cd $PROJECT_DIR/admin-ui && npm run dev"
    if $RUN_SCHEDULER; then
        echo "Scheduler|$PROJECT_DIR/.tmp-scheduler.sh"
    fi
    if $RUN_EMAIL_SCHEDULER; then
        echo "Email Scheduler|$PROJECT_DIR/.tmp-email-scheduler.sh"
    fi

elif [[ "$OSTYPE" == "darwin"* ]]; then
    # Open terminals
    echo "Opening Terminal windows..."

    # Check if user wants Warp (requires accessibility permissions)
    if $USE_WARP && [[ -d "/Applications/Warp.app" ]]; then
        echo -e "${YELLOW}Opening Warp... (requires Accessibility permissions for automation)${NC}"
        echo -e "${BLUE}If this fails, grant Terminal access in System Settings → Privacy → Accessibility${NC}"

        osascript -e 'tell application "Warp" to activate'
        sleep 0.5

        # Open new tabs using AppleScript GUI scripting
        # Use key code 36 for Return (more reliable than keystroke return)
        if $USE_TUNNEL; then
            osascript -e 'tell application "System Events" to keystroke "t" using command down' 2>/dev/null
            sleep 0.5
            osascript -e "tell application \"System Events\" to keystroke \"cd '$PROJECT_DIR' && ./.tmp-db-tunnel.sh; rm -f ./.tmp-db-tunnel.sh\"" 2>/dev/null
            sleep 0.2
            osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
            sleep 0.5
        fi

        osascript -e 'tell application "System Events" to keystroke "t" using command down' 2>/dev/null
        sleep 0.5
        osascript -e "tell application \"System Events\" to keystroke \"cd '$PROJECT_DIR' && ./.tmp-backend.sh; rm -f ./.tmp-backend.sh\"" 2>/dev/null
        sleep 0.2
        osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
        sleep 0.5

        osascript -e 'tell application "System Events" to keystroke "t" using command down' 2>/dev/null
        sleep 0.5
        osascript -e "tell application \"System Events\" to keystroke \"cd '$PROJECT_DIR' && ./.tmp-frontend.sh; rm -f ./.tmp-frontend.sh\"" 2>/dev/null
        sleep 0.2
        osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
        sleep 0.5

        if $RUN_SCHEDULER; then
            osascript -e 'tell application "System Events" to keystroke "t" using command down' 2>/dev/null
            sleep 0.5
            osascript -e "tell application \"System Events\" to keystroke \"cd '$PROJECT_DIR' && ./.tmp-scheduler.sh; rm -f ./.tmp-scheduler.sh\"" 2>/dev/null
            sleep 0.2
            osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
        fi

        if $RUN_EMAIL_SCHEDULER; then
            osascript -e 'tell application "System Events" to keystroke "t" using command down' 2>/dev/null
            sleep 0.5
            osascript -e "tell application \"System Events\" to keystroke \"cd '$PROJECT_DIR' && ./.tmp-email-scheduler.sh; rm -f ./.tmp-email-scheduler.sh\"" 2>/dev/null
            sleep 0.2
            osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
        fi

        echo -e "${GREEN}✓ Warp tabs opened${NC}"
    else
        # Use Terminal.app with windows
        if $USE_TUNNEL; then
            SCHEDULER_CMD=""
            if $RUN_SCHEDULER; then
                SCHEDULER_CMD="
    delay 0.5

    -- Scheduler window
    do script \"cd '$PROJECT_DIR' && ./.tmp-scheduler.sh; rm -f ./.tmp-scheduler.sh\"
    set schedulerWindow to front window
    set custom title of schedulerWindow to \"Envoy: Scheduler\"
"
            fi
            EMAIL_SCHEDULER_CMD=""
            if $RUN_EMAIL_SCHEDULER; then
                EMAIL_SCHEDULER_CMD="
    delay 0.5

    -- Email Scheduler window
    do script \"cd '$PROJECT_DIR' && ./.tmp-email-scheduler.sh; rm -f ./.tmp-email-scheduler.sh\"
    set emailSchedulerWindow to front window
    set custom title of emailSchedulerWindow to \"Envoy: Email Scheduler\"
"
            fi
            osascript << APPLESCRIPT
tell application "Terminal"
    activate

    -- Database tunnel window
    do script "cd '$PROJECT_DIR' && ./.tmp-db-tunnel.sh; rm -f ./.tmp-db-tunnel.sh"
    set tunnelWindow to front window
    set custom title of tunnelWindow to "Envoy: DB Tunnel"

    delay 0.5

    -- Backend window
    do script "cd '$PROJECT_DIR' && ./.tmp-backend.sh; rm -f ./.tmp-backend.sh"
    set backendWindow to front window
    set custom title of backendWindow to "Envoy: Backend API"

    delay 0.5

    -- Frontend window
    do script "cd '$PROJECT_DIR' && ./.tmp-frontend.sh; rm -f ./.tmp-frontend.sh"
    set frontendWindow to front window
    set custom title of frontendWindow to "Envoy: Frontend"
$SCHEDULER_CMD$EMAIL_SCHEDULER_CMD
end tell
APPLESCRIPT
        else
            SCHEDULER_CMD=""
            if $RUN_SCHEDULER; then
                SCHEDULER_CMD="
    delay 0.5

    -- Scheduler window
    do script \"cd '$PROJECT_DIR' && ./.tmp-scheduler.sh; rm -f ./.tmp-scheduler.sh\"
    set schedulerWindow to front window
    set custom title of schedulerWindow to \"Envoy: Scheduler\"
"
            fi
            EMAIL_SCHEDULER_CMD=""
            if $RUN_EMAIL_SCHEDULER; then
                EMAIL_SCHEDULER_CMD="
    delay 0.5

    -- Email Scheduler window
    do script \"cd '$PROJECT_DIR' && ./.tmp-email-scheduler.sh; rm -f ./.tmp-email-scheduler.sh\"
    set emailSchedulerWindow to front window
    set custom title of emailSchedulerWindow to \"Envoy: Email Scheduler\"
"
            fi
            osascript << APPLESCRIPT
tell application "Terminal"
    activate

    -- Backend window
    do script "cd '$PROJECT_DIR' && ./.tmp-backend.sh; rm -f ./.tmp-backend.sh"
    set backendWindow to front window
    set custom title of backendWindow to "Envoy: Backend API"

    delay 0.5

    -- Frontend window
    do script "cd '$PROJECT_DIR' && ./.tmp-frontend.sh; rm -f ./.tmp-frontend.sh"
    set frontendWindow to front window
    set custom title of frontendWindow to "Envoy: Frontend"
$SCHEDULER_CMD$EMAIL_SCHEDULER_CMD
end tell
APPLESCRIPT
        fi
        echo -e "${GREEN}✓ Terminal windows opened${NC}"
    fi
else
    echo -e "${YELLOW}Not on macOS - please start services manually:${NC}"
    TERM_NUM=1
    if $USE_TUNNEL; then
        echo "  Terminal $TERM_NUM: ./scripts/db-tunnel.sh dev 5433"
        TERM_NUM=$((TERM_NUM + 1))
    fi
    echo "  Terminal $TERM_NUM: ./scripts/local-dev.sh"
    TERM_NUM=$((TERM_NUM + 1))
    echo "  Terminal $TERM_NUM: cd admin-ui && npm run dev"
    if $RUN_SCHEDULER; then
        TERM_NUM=$((TERM_NUM + 1))
        echo "  Terminal $TERM_NUM: ./.tmp-scheduler.sh"
    fi
    if $RUN_EMAIL_SCHEDULER; then
        TERM_NUM=$((TERM_NUM + 1))
        echo "  Terminal $TERM_NUM: ./.tmp-email-scheduler.sh"
    fi
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

if $USE_BG; then
    echo "Parse the commands above (after ---CLAUDE_CODE_COMMANDS---) to start as background tasks."
    echo ""
    echo "Services will be available at:"
else
    echo "Services starting in separate terminal windows:"
fi
echo ""
if $USE_TUNNEL; then
    echo -e "  ${BLUE}DB Tunnel${NC}  → Connecting to dev Aurora on localhost:5433"
fi
echo -e "  ${BLUE}Backend${NC}    → http://localhost:8000 (API docs: /docs)"
echo -e "  ${BLUE}Frontend${NC}   → http://localhost:3000"
if $RUN_SCHEDULER; then
    echo -e "  ${BLUE}Scheduler${NC}  → Running every 30 seconds"
fi
if $RUN_EMAIL_SCHEDULER; then
    echo -e "  ${BLUE}Email Sched${NC} → Running every 60 seconds"
fi
echo ""
if ! $USE_BG; then
    echo "Wait a few seconds for services to start, then open:"
    echo -e "  ${GREEN}→ http://localhost:3000${NC}"
    echo ""
fi
