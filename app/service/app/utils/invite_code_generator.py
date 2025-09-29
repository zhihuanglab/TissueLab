import random
import hashlib

class InviteCodeGenerator:
    def __init__(self):
        self.chars = ''.join(set('0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'))

        # invite code length config
        self.TOTAL_LENGTH = 16
        self.CHECKSUM_LENGTH = 4
        self.BASE_LENGTH = self.TOTAL_LENGTH - self.CHECKSUM_LENGTH

        self._init_shuffle_tables()

    def _init_shuffle_tables(self):
        """initialize multiple shuffle tables, for different position character conversion"""
        self.position_maps = []
        for _ in range(self.BASE_LENGTH):
            chars = list(self.chars)
            mapped_chars = chars.copy()
            random.shuffle(mapped_chars)
            self.position_maps.append(dict(zip(chars, mapped_chars)))

    def generate_code(self, user_id: str) -> str:
        """
        generate 16-digit invite code
        structure: 12 random digits + 4 checksum digits
        """
        try:
            base_code = self._generate_base_code(user_id)
            checksum = self._generate_checksum(base_code, user_id)
            return f"{base_code}{checksum}"

        except Exception as e:
            raise Exception(f"Failed to generate invite code: {str(e)}")

    def _generate_base_code(self, user_id: str) -> str:
        """generate base random code"""
        # use user id as seed
        user_seed = hashlib.sha256(str(user_id).encode()).hexdigest()

        random_chars = []
        for i in range(self.BASE_LENGTH):
            seed = f"{user_seed}{random.randint(0, 999999)}{i}"
            random_value = int(hashlib.md5(seed.encode()).hexdigest(), 16)
            char_index = random_value % len(self.chars)

            char = self.chars[char_index]
            mapped_char = self.position_maps[i].get(char, char)
            random_chars.append(mapped_char)

        return ''.join(random_chars)

    def _generate_checksum(self, base_code: str, user_id: str) -> str:
        """generate checksum"""
        features = [
            base_code,
            user_id,
            str(random.randint(1000, 9999))
        ]
        check_string = ''.join(features)
        return hashlib.sha256(check_string.encode()).hexdigest()[:4].upper()
