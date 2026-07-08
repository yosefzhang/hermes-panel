from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import jwt

from backend.auth.models import UserCreate, UserUpdate
from backend.config import Settings
from backend.db.database import connect, hash_password, row_to_user, verify_password
from backend.db.models import User

# The seeded administrator account can never be deleted, otherwise a
# fresh install could lock itself out.
DEFAULT_ADMIN_USERNAME = "admin"


class AuthService:
    def __init__(self, settings: Settings):
        self.settings = settings

    def authenticate(self, username: str, password: str) -> User | None:
        user = self.get_user_by_username(username)
        if not user or not verify_password(password, user.password_hash):
            return None
        return user

    def create_access_token(self, user: User) -> str:
        expires = datetime.now(timezone.utc) + timedelta(hours=self.settings.jwt_expires_hours)
        payload = {
            "sub": str(user.id),
            "username": user.username,
            "role": user.role,
            "profiles": user.profiles,
            "exp": expires,
        }
        return jwt.encode(payload, self.settings.jwt_secret, algorithm=self.settings.jwt_algorithm)

    def user_from_token(self, token: str) -> User | None:
        payload = jwt.decode(token, self.settings.jwt_secret, algorithms=[self.settings.jwt_algorithm])
        return self.get_user(int(payload["sub"]))

    def get_user(self, user_id: int) -> User | None:
        with connect(self.settings.control_db_path) as connection:
            row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return row_to_user(row)

    def get_user_by_username(self, username: str) -> User | None:
        with connect(self.settings.control_db_path) as connection:
            row = connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return row_to_user(row)

    def list_users(self) -> list[dict]:
        with connect(self.settings.control_db_path) as connection:
            rows = connection.execute("SELECT * FROM users ORDER BY id").fetchall()
        return [row_to_user(row).public_dict() for row in rows]

    def create_user(self, payload: UserCreate) -> dict:
        now = time.time()
        profiles = ["*"] if payload.role == "admin" else payload.profiles
        try:
            with connect(self.settings.control_db_path) as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO users (username, password_hash, role, profiles, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload.username,
                        hash_password(payload.password),
                        payload.role,
                        json.dumps(profiles),
                        now,
                        now,
                    ),
                )
                user_id = cursor.lastrowid
        except sqlite3.IntegrityError as error:
            raise ValueError("username already exists") from error
        return self.get_user(user_id).public_dict()

    def update_user(self, user_id: int, payload: UserUpdate) -> dict | None:
        user = self.get_user(user_id)
        if user is None:
            return None

        role = payload.role if payload.role is not None else user.role
        profiles = payload.profiles if payload.profiles is not None else user.profiles
        if role == "admin":
            profiles = ["*"]

        assignments = ["role = ?", "profiles = ?", "updated_at = ?"]
        values: list[object] = [role, json.dumps(profiles), time.time()]
        if payload.password:
            assignments.append("password_hash = ?")
            values.append(hash_password(payload.password))
        values.append(user_id)

        with connect(self.settings.control_db_path) as connection:
            connection.execute(f"UPDATE users SET {', '.join(assignments)} WHERE id = ?", values)
        return self.get_user(user_id).public_dict()

    def delete_user(self, user_id: int) -> bool:
        with connect(self.settings.control_db_path) as connection:
            cursor = connection.execute(
                "DELETE FROM users WHERE id = ? AND username != ?",
                (user_id, DEFAULT_ADMIN_USERNAME),
            )
        return cursor.rowcount > 0