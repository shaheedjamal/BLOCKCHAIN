# CivicLedger — Blockchain-Based Land Record Management System

> **Academic Prototype Notice:** All parcels, user accounts, GIS coordinates, and Hyperledger Fabric consortium transactions in this repository use synthetic demonstration data. Document SHA-256 verification confirms binary byte integrity only and does not constitute legal ownership or title adjudication.

## Architecture Overview

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Leaflet GIS map, Lucide icons.
- **Backend:** Node.js 22, Express, TypeScript (`tsx`), JWT + `httpOnly` cookie authentication, `bcryptjs` password hashing, Multer memory upload & private server storage (`./storage/documents`).
- **Database:** Embedded relational SQLite via Node 22 `node:sqlite` (`WAL` mode, `PRAGMA foreign_keys = ON`) with full PostgreSQL + PostGIS reference migration DDL in `db/migrations/001_postgres_postgis_schema.sql`.
- **Blockchain Simulation:** Local Simulated Hyperledger Fabric permissioned consortium engine (`server/blockchain.ts`) modeling `RevenueDeptMSP`, `SurveyGISMSP`, and `RegistrarAuthorityMSP`, enforcing optimistic parcel versioning, duplicate transaction prevention, mandatory approval references, minimal on-chain metadata, and SHA-256 hash-linked event blocks. Production chaincode reference is provided in `chaincode/land_record_chaincode.js`.

## Implemented User Roles & Capabilities

1. **Citizen (`CITIZEN`)**: View permitted parcels, search owned records, submit Land Transfer / Land Mutation / Record Correction / Document Verification applications, upload supporting files, verify document SHA-256 hashes, download acknowledgement receipts, receive notifications.
2. **Clerk (`CLERK`)**: Check application completeness, verify mandatory fields and uploaded files, add review remarks, return incomplete applications, route verified applications to Surveyors.
3. **Surveyor (`SURVEYOR`)**: Inspect assigned parcels, review synthetic GIS boundaries and survey evidence, upload survey reports, enter survey verification notes, advance to Approving Officer.
4. **Approving Officer (`APPROVING_OFFICER`)**: Review clerk remarks, surveyor findings, and SHA-256 document status; approve, reject, return, or escalate applications; issue official approval references; record approved events onto the simulated Fabric ledger.
5. **Administrator (`ADMIN`)**: Manage users, roles, account lockouts, simulated Fabric network availability, MSP certificates, system configuration, notification broadcasts, database & private document backup/restoration.
6. **Auditor (`AUDITOR`)**: Read-only access to audit logs, ledger event integrity verification, application/parcel records, and downloadable CSV/JSON compliance reports.

## Synthetic Demo Accounts

All seeded demo accounts use password `DemoPass@2026`:

- `citizen@demo.landgov` (Citizen — Arun Kumar)
- `citizen2@demo.landgov` (Citizen — Meera Nair)
- `clerk@demo.landgov` (Clerk — Priya Sharma)
- `surveyor@demo.landgov` (Surveyor — Vikram Rao)
- `officer@demo.landgov` (Approving Officer — Dr. Kavitha Subramanian)
- `admin@demo.landgov` (Administrator — Rajan Deshmukh)
- `auditor@demo.landgov` (Auditor — Lakshmi Menon)

## Local Setup & Commands

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (optional; sensible defaults apply)
cp .env.example .env

# 3. Start full-stack dev server (port 3000)
npm run dev

# 4. Run automated test suite (TC-01 through TC-14)
npm run test:tc

# 5. Typecheck & build production bundle
npm run lint
npm run build
npm run start
```

## Docker Deployment

```bash
docker compose up --build
```
