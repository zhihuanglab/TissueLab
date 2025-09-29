from typing import Optional, Dict

import aiohttp
from fastapi import Request
from app.core import logger

def get_client_ip(request: Request) -> Optional[str]:
    """
    get client ip address
    """
    x_forwarded_for = request.headers.get('x-forwarded-for')
    socket_remote_addr = request.client.host if request.client else None

    logger.info(f"X-Forwarded-For: {x_forwarded_for}")
    logger.info(f"Socket Remote Address: {socket_remote_addr}")

    if x_forwarded_for:
        # split and get first ip address
        ip = x_forwarded_for.split(',')[0].strip()
    else:
        ip = socket_remote_addr

    return ip

def get_device_id(request: Request) -> Optional[str]:
    return request.headers.get("X-Device-Id") or request.headers.get("x-device-id")

async def get_location_data(ip_address: str) -> Dict[str, str]:
    """
    get ip address location info from ip-api.com
    """
    try:
        # get last ipv4 address
        clean_ip = ip_address.split(',')[-1].strip() if ',' in ip_address else ip_address

        # use aiohttp to call ip-api.com service
        async with aiohttp.ClientSession() as session:
            async with session.get(f'http://ip-api.com/json/{clean_ip}') as response:
                data = await response.json()

                locate_data = {
                    "country": data.get('country', ''),
                    "region": data.get('region', ''),
                    "city": data.get('city', '')
                }

                return locate_data

    except Exception as error:
        logger.error('Error getting location data:', exc_info=error)
        # return empty value when error occurs
        return {
            "country": '',
            "region": '',
            "city": ''
        }