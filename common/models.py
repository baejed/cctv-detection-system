from sqlalchemy import BigInteger, Column, Integer, String, ForeignKey, DateTime, Float, Boolean, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from common.database import Base


class User(Base):
    __tablename__ = "users"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), nullable=False, unique=True)
    hash     = Column(String(255), nullable=False)
    role     = Column(String(50),  nullable=False, default="viewer")
    time     = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    sessions           = relationship("UserSession",      back_populates="user", cascade="all, delete")
    uploaded_videos    = relationship("Video",            back_populates="uploader",          foreign_keys="Video.uploaded_by")
    push_subscriptions = relationship("PushSubscription", back_populates="user", cascade="all, delete")


class UserSession(Base):
    __tablename__ = "user_sessions"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="sessions")


class Log(Base):
    __tablename__ = "logs"

    id      = Column(Integer, primary_key=True, autoincrement=True)
    message = Column(String(255), nullable=False)
    time    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Intersection(Base):
    __tablename__ = "intersections"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    name      = Column(String(255), nullable=False)
    latitude  = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    time      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    streets         = relationship("Street",         back_populates="intersection", cascade="all, delete")
    cctvs           = relationship("CCTV",           back_populates="intersection", cascade="all, delete")
    recommendations = relationship("Recommendation", back_populates="intersection", cascade="all, delete")
    videos          = relationship("Video",          back_populates="intersection")


class Street(Base):
    __tablename__ = "streets"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(255), nullable=False)
    time            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="streets")
    regions      = relationship("Region", back_populates="street", cascade="all, delete")


class CCTV(Base):
    __tablename__ = "cctvs"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(255), nullable=False)
    rtsp_url        = Column(String(255), nullable=False)
    status          = Column(String(50),  nullable=False, default="offline")
    is_being_viewed = Column(Boolean,     nullable=False, default=False)
    time            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    intersection = relationship("Intersection", back_populates="cctvs")
    detections   = relationship("Detection",       back_populates="cctv",  cascade="all, delete")
    regions      = relationship("Region",          back_populates="cctv",  cascade="all, delete")
    heartbeat    = relationship("WorkerHeartbeat", back_populates="cctv",  uselist=False, cascade="all, delete")


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id           = Column(Integer, ForeignKey("cctvs.id", ondelete="CASCADE"), nullable=False, unique=True)
    worker_pid        = Column(Integer, nullable=False)
    last_seen         = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claimed_at        = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claim_version     = Column(Integer, nullable=False, default=0)
    status            = Column(String(50), nullable=False, default="running")
    frames_per_second = Column(Float, nullable=True)
    last_error        = Column(String(500), nullable=True)
    cctv = relationship("CCTV", back_populates="heartbeat")


class Region(Base):
    __tablename__ = "regions"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id   = Column(Integer, ForeignKey("cctvs.id",   ondelete="CASCADE"), nullable=False)
    street_id = Column(Integer, ForeignKey("streets.id", ondelete="CASCADE"), nullable=False)
    direction = Column(String(10), nullable=False, default="unknown")
    time      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv                  = relationship("CCTV",   back_populates="regions")
    street                = relationship("Street", back_populates="regions")
    region_points         = relationship("RegionPoint",       back_populates="region", cascade="all, delete")
    detections_in_regions = relationship("DetectionInRegion", back_populates="region", cascade="all, delete")


class RegionPoint(Base):
    __tablename__ = "region_points"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    region_id = Column(Integer, ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    x         = Column(Float, nullable=False)  # normalized 0-1, NOT pixel coordinates
    y         = Column(Float, nullable=False)  # normalized 0-1, NOT pixel coordinates
    time      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region = relationship("Region", back_populates="region_points")


class Detection(Base):
    __tablename__ = "detections"

    id          = Column(BigInteger, primary_key=True, autoincrement=True)
    cctv_id     = Column(Integer, ForeignKey("cctvs.id",  ondelete="CASCADE"),  nullable=False)
    video_id    = Column(Integer, ForeignKey("videos.id", ondelete="SET NULL"), nullable=True)
    track_id    = Column(Integer,    nullable=True)
    object_type = Column(String(50), nullable=False)
    confidence  = Column(Float,      nullable=False)
    x1          = Column(Float,      nullable=False)
    y1          = Column(Float,      nullable=False)
    x2          = Column(Float,      nullable=False)
    y2          = Column(Float,      nullable=False)
    time        = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv                  = relationship("CCTV",  back_populates="detections")
    video                 = relationship("Video", back_populates="detections")
    detections_in_regions = relationship(
        "DetectionInRegion",
        back_populates="detection",
        cascade="all, delete",
        primaryjoin="Detection.id == DetectionInRegion.detection_id",
        foreign_keys="[DetectionInRegion.detection_id]",
    )


class DetectionInRegion(Base):
    __tablename__ = "detections_in_regions"

    id           = Column(Integer,    primary_key=True, autoincrement=True)
    region_id    = Column(Integer,    ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    detection_id = Column(BigInteger, nullable=False)
    time         = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region    = relationship("Region",    back_populates="detections_in_regions")
    detection = relationship(
        "Detection",
        back_populates="detections_in_regions",
        primaryjoin="DetectionInRegion.detection_id == Detection.id",
        foreign_keys="DetectionInRegion.detection_id",
    )


class Video(Base):
    __tablename__ = "videos"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id  = Column(Integer, ForeignKey("intersections.id", ondelete="SET NULL"), nullable=True)
    uploaded_by      = Column(Integer, ForeignKey("users.id",         ondelete="SET NULL"), nullable=True)
    filename         = Column(String(255), nullable=False)
    filepath         = Column(String(255), nullable=False)
    recorded_at      = Column(DateTime(timezone=True), nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    total_frames     = Column(Integer, nullable=True)
    processed_frames = Column(Integer, nullable=False, default=0)
    status           = Column(String(50), nullable=False, default="pending")
    uploaded_at      = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    processed_at     = Column(DateTime(timezone=True), nullable=True)

    intersection = relationship("Intersection", back_populates="videos")
    uploader     = relationship("User",         back_populates="uploaded_videos", foreign_keys=[uploaded_by])
    detections   = relationship("Detection",    back_populates="video")


class Recommendation(Base):
    __tablename__ = "recommendations"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id        = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    warrant_1_met          = Column(Boolean, nullable=False, default=False)
    warrant_1_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_2_met          = Column(Boolean, nullable=False, default=False)
    warrant_2_confidence   = Column(Float,   nullable=False, default=0.0)
    warrant_4_met          = Column(Boolean, nullable=False, default=False)
    warrant_4_confidence   = Column(Float,   nullable=False, default=0.0)
    recommended            = Column(Boolean, nullable=False, default=False)
    recommended_confidence = Column(Float,   nullable=True)
    major_volume           = Column(Integer, nullable=True)
    minor_volume           = Column(Integer, nullable=True)
    peds                   = Column(Integer, nullable=True)
    vpm                    = Column(Integer, nullable=True)
    phf                    = Column(Float,   nullable=True)
    hour_start             = Column(DateTime(timezone=True), nullable=True)
    notes                  = Column(Text,    nullable=True)
    generated_at           = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    intersection = relationship("Intersection", back_populates="recommendations")


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    endpoint   = Column(Text,    nullable=False, unique=True)
    p256dh     = Column(Text,    nullable=False)
    auth       = Column(Text,    nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="push_subscriptions")


class AggregationSummary(Base):
    __tablename__ = "aggregation_summaries"
    __table_args__ = {"info": {"is_view": True}}

    intersection_id = Column(Integer,    primary_key=True)
    street_id       = Column(Integer,    primary_key=True)
    direction       = Column(String(10), primary_key=True)
    object_type     = Column(String(50), primary_key=True)
    window_start    = Column(DateTime(timezone=True), primary_key=True)
    count           = Column(Integer,    nullable=False)