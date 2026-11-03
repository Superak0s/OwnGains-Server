ALTER TABLE sharing_permissions MODIFY permission_type ENUM('history','analytics','program','joint_session','watch_session','trainer','tracking','machines') NOT NULL;
